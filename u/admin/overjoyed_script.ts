import * as wmillclient from "windmill-client";
import wmill from "windmill-cli";
import { basename, join } from "node:path";
import { existsSync } from "fs";
const util = require("util");
const exec = util.promisify(require("child_process").exec);
import process from "process";

type GpgKey = {
  email: string;
  private_key: string;
  passphrase: string;
};

type GitRepository = {
  url: string;
  branch: string;
  folder: string;
  gpg_key: any;
  is_github_app: boolean;
};

const FORKED_WORKSPACE_PREFIX = "wm-fork-";
const FORKED_BRANCH_PREFIX = "wm-fork";

let gpgFingerprint: string | undefined = undefined;

export async function main(
  workspace_id: string,
  repo_url_resource_path: string,
  dry_run: boolean,
  only_wmill_yaml: boolean = false,
  pull: boolean = false,
  settings_json?: string, // JSON settings from UI for new CLI approach
  use_promotion_overrides?: boolean // Use promotionOverrides from repo branch when "use separate branch" toggle is selected
) {
  let safeDirectoryPath: string | undefined;
  console.log("DEBUG: Starting main function", {
    workspace_id,
    // repo_url_resource_path,
    dry_run,
    only_wmill_yaml,
    pull,
    settings_json: settings_json ? "PROVIDED" : "NOT_PROVIDED",
  });

  const repo_resource: GitRepository = await wmillclient.getResource(
    repo_url_resource_path
  );

  process.env.GIT_TERMINAL_PROMPT = "0";
  console.log("DEBUG: Set GIT_TERMINAL_PROMPT=0 to prevent interactive prompts");

  console.log("DEBUG: Retrieved repo resource", {
    url: repo_resource.url,
    branch: repo_resource.branch,
    folder: repo_resource.folder,
    is_github_app: repo_resource.is_github_app,
    has_gpg: repo_resource.gpg_key,
  });

  // Extract clean repository path for CLI commands (remove $res: prefix)
  const repository_path = repo_url_resource_path.startsWith("$res:")
    ? repo_url_resource_path.substring(5)
    : repo_url_resource_path;
  console.log("DEBUG: Repository path for CLI:", repository_path);

  // Extract promotion branch from git repository resource if use_promotion_overrides is enabled
  const promotion_branch = use_promotion_overrides ? repo_resource.branch : undefined;
  console.log("DEBUG: Promotion branch:", promotion_branch);

  const cwd = process.cwd();
  console.log("DEBUG: Current working directory:", cwd);
  process.env["HOME"] = ".";

  if (repo_resource.is_github_app) {
    console.log("DEBUG: Using GitHub App authentication");
    const token = await get_gh_app_token();
    console.log("DEBUG: Got GitHub App token:", token ? "SUCCESS" : "FAILED");
    const authRepoUrl = prependTokenToGitHubUrl(repo_resource.url, token);
    console.log("DEBUG: URL conversion:", {
      original: repo_resource.url,
      authenticated: authRepoUrl,
    });
    repo_resource.url = authRepoUrl;
  }

  console.log("DEBUG: Starting git clone...");
  const { repo_name, safeDirectoryPath: cloneSafeDirectoryPath, clonedBranchName } = await git_clone(cwd, repo_resource, pull, workspace_id);
  safeDirectoryPath = cloneSafeDirectoryPath;
  console.log("DEBUG: Git clone completed, repo name:", repo_name);

  const subfolder = repo_resource.folder ?? "";
  const fullPath = join(cwd, repo_name, subfolder);
  console.log("DEBUG: Full path:", fullPath);

  process.chdir(fullPath);
  console.log("DEBUG: Changed directory to:", process.cwd());

  // Set up workspace context for CLI commands
  console.log("DEBUG: Setting up workspace...");
  await wmill_run(
    6,
    "workspace",
    "add",
    workspace_id,
    workspace_id,
    process.env["BASE_URL"] + "/",
    "--token",
    process.env["WM_TOKEN"] ?? ""
  );
  console.log("DEBUG: Workspace setup completed");

  let result;
  try {
    console.log("DEBUG: Entering main execution branch", {
      only_wmill_yaml,
      pull,
      dry_run,
    });

    if (only_wmill_yaml) {
      // Settings-only operations (wmill.yaml)
      result = await executeSettingsOperation(
        workspace_id,
        repository_path,
        settings_json,
        fullPath,
        pull,
        dry_run,
        clonedBranchName,
        repo_resource,
        promotion_branch
      );
    } else {
      // Full sync operations
      result = await executeSyncOperation(
        workspace_id,
        repository_path,
        settings_json,
        fullPath,
        repo_resource,
        pull,
        dry_run,
        clonedBranchName,
        promotion_branch
      );
    }

    console.log("DEBUG: Main execution completed successfully", result);
  } catch (error) {
    console.log("DEBUG: Error in main execution:", error);
    throw error;
  } finally {
    // Cleanup: remove safe.directory config
    if (safeDirectoryPath) {
      try {
        await sh_run(undefined, "git", "config", "--global", "--unset", "safe.directory", safeDirectoryPath);
      } catch (e) {
        console.log(`Warning: Could not unset safe.directory config: ${e}`);
      }
    }
    console.log("DEBUG: Changing back to original directory:", cwd);
    process.chdir(cwd);
  }

  // Return the result directly from the CLI command
  return result;
}

async function executeSettingsOperation(
  workspace_id: string,
  repository_path: string,
  settings_json: string | undefined,
  fullPath: string,
  pull: boolean,
  dry_run: boolean,
  clonedBranchName: string,
  repo_resource?: any,
  promotion_branch?: string
) {
  if (pull) {
    console.log("DEBUG: Executing pull branch (wmill.yaml only)");
    // Frontend PULL = Git→Windmill = CLI settings push (push wmill.yaml from Git to Windmill)
    if (dry_run) {
      return await executeCliSettingsPushDryRun(
        workspace_id,
        repository_path,
        settings_json,
        fullPath,
        promotion_branch
      );
    } else {
      // For actual pull, we still just want to return the git repo settings_json
      return await executeCliSettingsPushDryRun(
        workspace_id,
        repository_path,
        settings_json,
        fullPath,
        promotion_branch
      );
    }
  } else {
    console.log("DEBUG: Executing push branch (wmill.yaml only)");
    // Frontend PUSH = Windmill→Git = CLI settings pull (pull from Windmill to generate wmill.yaml)
    if (dry_run) {
      return await executeCliSettingsPullDryRun(
        workspace_id,
        repository_path,
        settings_json,
        fullPath,
        promotion_branch
      );
    } else {
      if (!settings_json) throw Error("settings_json required in this mode");
      return await executeCliSettingsPull(
        workspace_id,
        repository_path,
        fullPath,
        settings_json,
        repo_resource,
        promotion_branch
      );
    }
  }
}

async function executeSyncOperation(
  workspace_id: string,
  repository_path: string,
  settings_json: string | undefined,
  fullPath: string,
  repo_resource: any,
  pull: boolean,
  dry_run: boolean,
  clonedBranchName: string,
  promotion_branch?: string
) {
  if (pull) {
    console.log("DEBUG: Executing sync pull", { dry_run });
    // Frontend PULL = Git→Windmill = CLI sync push
    if (dry_run) {
      return await executeCliSyncPushDryRun(
        workspace_id,
        repository_path,
        settings_json,
        fullPath,
        promotion_branch
      );
    } else {
      return await executeCliSyncPush(
        workspace_id,
        repository_path,
        repo_resource,
        settings_json
      );
    }
  } else {
    console.log("DEBUG: Executing sync push", { dry_run });
    // Frontend PUSH = Windmill→Git = CLI sync pull
    if (dry_run) {
      return await executeCliSyncPullDryRun(
        workspace_id,
        repository_path,
        settings_json,
        fullPath
      );
    } else {
      return await executeCliSyncPull(
        workspace_id,
        repository_path,
        repo_resource,
        clonedBranchName,
        settings_json
      );
    }
  }
}

// Use existing CLI settings pull --dry-run (from settings.ts)
async function executeCliSettingsPullDryRun(
  workspace_id: string,
  repository_path: string,
  settings_json?: string,
  repoPath?: string,
  promotion_branch?: string
) {
  try {
    // Check if wmill.yaml exists in the git repo
    let wmillYamlExists = existsSync("wmill.yaml");
    if (!wmillYamlExists) {
      console.log(
        "DEBUG: No wmill.yaml found, will create with repository settings"
      );

      // For new repositories, don't show a confusing diff between defaults and settings
      // Just return a simple success message indicating the file will be created
      return {
        success: true,
        hasChanges: true,
        message: "wmill.yaml will be created with repository settings",
        isInitialSetup: true,
        repository: repository_path
      };
    }

    // Use gitsync-settings diff for UI settings comparison
    // This shows what would change in Git if we pulled from Windmill
    const args = [
      undefined,
      "gitsync-settings",
      "pull",
      "--diff",
      "--repository",
      repository_path,
      "--workspace",
      workspace_id,
      "--override",
    ];

    if (settings_json) {
      args.push("--with-backend-settings", settings_json);
    }

    if (promotion_branch) {
      args.push("--promotion", promotion_branch);
    }

    args.push(
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/",
      "--json-output"
    );

    return await wmill_run(...args);
  } catch (error) {
    const errorMessage = error.message || error.toString();
    // Check if this is an empty repository error (no commits/branches yet)
    if ((errorMessage.includes("src refspec") && errorMessage.includes("does not match any")) ||
        (errorMessage.includes("Remote branch") && errorMessage.includes("not found"))) {
      console.log("DEBUG: Empty repository detected - branch doesn't exist or no commits");
      return {
        success: true,
        hasChanges: true,
        message: "Empty repository detected - requires initialization",
        isInitialSetup: true,
        repository: repository_path
      };
    }
    throw new Error("Settings pull dry run failed: " + errorMessage);
  }
}

// Use existing CLI settings push --dry-run (from settings.ts)
async function executeCliSettingsPushDryRun(
  workspace_id: string,
  repository_path: string,
  settings_json?: string,
  repoPath?: string,
  promotion_branch?: string
) {
  try {
    console.log("DEBUG: Settings push dry run with JSON:", settings_json);

    // Check if wmill.yaml exists in the git repo
    if (!existsSync("wmill.yaml")) {
      console.log("DEBUG: No wmill.yaml found in git repository");
      throw new Error(
        "No wmill.yaml found in the git repository. Please initialize the repository first by pushing settings from Windmill to git."
      );
    }

    // Use gitsync-settings push for UI settings comparison
    const args = [
      undefined,
      "gitsync-settings",
      "push",
      "--diff",
      "--repository",
      repository_path,
      "--workspace",
      workspace_id,
    ];

    if (settings_json) {
      args.push("--with-backend-settings", settings_json);
    }

    if (promotion_branch) {
      args.push("--promotion", promotion_branch);
    }

    args.push(
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/",
      "--json-output"
    );

    return await wmill_run(...args);
  } catch (error) {
    throw new Error("Settings push dry run failed: " + error.message);
  }
}

// Use existing CLI settings pull (from settings.ts)
async function executeCliSettingsPull(
  workspace_id: string,
  repository_path: string,
  repoPath: string,
  settings_json: string,
  clonedBranchName: string,
  repo_resource?: any,
  promotion_branch?: string
) {
  console.log("DEBUG: executeCliSettingsPull started", {
    workspace_id,
    repository_path,
    repoPath,
    settings_json: settings_json ? "PROVIDED" : "NOT_PROVIDED",
  });

  try {
    // Check if wmill.yaml exists in the git repo
    let wmillYamlExists = existsSync("wmill.yaml");
    if (!wmillYamlExists) {
      console.log(
        "DEBUG: No wmill.yaml found, initializing with default settings"
      );

      // Run wmill init with default settings
      await wmill_run(
        null,
        "init",
        "--use-default",
        "--token",
        process.env["WM_TOKEN"] ?? "",
        "--base-url",
        process.env["BASE_URL"] + "/",
        "--workspace",
        workspace_id
      );

      console.log("DEBUG: wmill.yaml initialized with defaults");
    }

    console.log("DEBUG: Running CLI gitsync-settings pull command...");
    const args = [
      null,
      "gitsync-settings",
      "pull",
      "--repository",
      repository_path,
      "--workspace",
      workspace_id,
      wmillYamlExists ? "--override" : "--replace",
    ];

    if (settings_json) {
      args.push("--with-backend-settings", settings_json);
    }

    if (promotion_branch) {
      args.push("--promotion", promotion_branch);
    }

    args.push(
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/"
    );

    const res = await wmill_run(...args);
    console.log("DEBUG: CLI settings pull result:", res);

    console.log("DEBUG: Starting git push process...");
    const pushResult = await git_push(
      "Update wmill.yaml via settings",
      repo_resource || { gpg_key: null },
      clonedBranchName
    );
    console.log("DEBUG: Git push completed:", pushResult);

    return { success: true, message: "Settings pushed to git successfully" };
  } catch (error) {
    console.log("DEBUG: Error in executeCliSettingsPull:", error);
    const errorMessage = error.message || error.toString();
    throw new Error("Settings pull failed: " + errorMessage);
  }
}

// Use existing CLI sync pull --dry-run
async function executeCliSyncPullDryRun(
  workspace_id: string,
  repository_path: string,
  settings_json?: string,
  repoPath?: string
) {
  try {
    console.log("DEBUG: executeCliSyncPullDryRun started", {
      workspace_id,
      repository_path,
      settings_json: settings_json ? "PROVIDED" : "NOT_PROVIDED",
    });

    // Check if wmill.yaml exists in the git repo
    let wmillYamlExists = existsSync("wmill.yaml");
    let settingsDiffResult = {}
    if (!wmillYamlExists) {
      console.log(
        "DEBUG: No wmill.yaml found, initializing with default settings"
      );

      // Run wmill init with default settings
      await wmill_run(
        null,
        "init",
        "--use-default",
        "--token",
        process.env["WM_TOKEN"] ?? "",
        "--base-url",
        process.env["BASE_URL"] + "/",
        "--workspace",
        workspace_id
      );

      console.log("DEBUG: wmill.yaml initialized with defaults");


      // Step 1: Check if wmill.yaml settings would change with gitsync-settings pull --diff
      console.log("DEBUG: Checking wmill.yaml changes with gitsync-settings pull --diff");
      const settingsDiffArgs = [
        null,
        "gitsync-settings",
        "pull",
        "--diff",
        "--repository",
        repository_path,
        "--workspace",
        workspace_id,
        "--replace",
        "--json-output"
      ];

      if (settings_json) {
        settingsDiffArgs.push("--with-backend-settings", settings_json);
      }


      settingsDiffArgs.push(
        "--token",
        process.env["WM_TOKEN"] ?? "",
        "--base-url",
        process.env["BASE_URL"] + "/"
      );

      settingsDiffResult = await wmill_run(...settingsDiffArgs);
      console.log("DEBUG: Settings diff result:", settingsDiffResult);

      // Step 2: Pull settings from backend (actual update)
      console.log("DEBUG: Pulling git-sync settings from backend");
      const settingsArgs = [
        null,
        "gitsync-settings",
        "pull",
        "--repository",
        repository_path,
        "--workspace",
        workspace_id,
        "--replace",
      ];

      if (settings_json) {
        settingsArgs.push("--with-backend-settings", settings_json);
      }


      settingsArgs.push(
        "--token",
        process.env["WM_TOKEN"] ?? "",
        "--base-url",
        process.env["BASE_URL"] + "/"
      );

      await wmill_run(...settingsArgs);
      console.log("DEBUG: Git-sync settings pulled successfully");
    }

    const args = [
      "sync",
      "pull",
      "--dry-run",
      "--json-output",
      "--workspace",
      workspace_id,
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/",
      "--repository",
      repository_path,
    ];

    const result = await wmill_run(null, ...args);

    // Step 3: Check for wmill.yaml changes using CLI hasChanges flag
    if (!result.changes) {
      result.changes = [];
    }

    const hasWmillYaml = result.changes.some(change => change.path === 'wmill.yaml');
    if (!hasWmillYaml) {
      if (!wmillYamlExists) {
        // We created it during init
        result.total = result.total + 1
        result.changes.push({ type: 'added', path: 'wmill.yaml' });
      } else if (settingsDiffResult?.hasChanges) {
        // Settings would change - add as modified using CLI detection
        console.log("DEBUG: Adding wmill.yaml as modified due to settings changes");
        result.total = result.total + 1
        result.changes.push({ type: 'edited', path: 'wmill.yaml' });
      }
    }

    return result;
  } catch (error) {
    throw new Error("Sync pull dry run failed: " + error.message);
  }
}

// Use existing CLI sync push --dry-run
async function executeCliSyncPushDryRun(
  workspace_id: string,
  repository_path: string,
  settings_json?: string,
  repoPath?: string,
  promotion_branch?: string
) {
  try {
    // Step 1: Check if wmill.yaml settings would change
    console.log("DEBUG: Checking wmill.yaml changes with gitsync-settings push --diff");
    const settingsArgs = [
      undefined,
      "gitsync-settings",
      "push",
      "--diff",
      "--repository",
      repository_path,
      "--workspace",
      workspace_id,
      "--json-output"
    ];

    if (settings_json) {
      settingsArgs.push("--with-backend-settings", settings_json);
    }

    if (promotion_branch) {
      settingsArgs.push("--promotion", promotion_branch);
    }

    settingsArgs.push(
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/"
    );

    const settingsDiffResult = await wmill_run(...settingsArgs);
    console.log("DEBUG: Settings diff result:", settingsDiffResult);

    // Step 2: Check resource changes with sync push --dry-run
    console.log("DEBUG: Checking resource changes with sync push --dry-run");
    const syncArgs = [
      "sync",
      "push",
      "--dry-run",
      "--json-output",
      "--workspace",
      workspace_id,
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/",
      "--repository",
      repository_path,
    ];

    const syncResult = await wmill_run(null, ...syncArgs);
    console.log("DEBUG: Sync result:", syncResult);

    // Step 3: Combine results - add wmill.yaml as modified if settings would change
    if (!syncResult.changes) {
      syncResult.changes = [];
    }

    if (settingsDiffResult?.hasChanges) {
      console.log("DEBUG: Adding wmill.yaml as modified due to settings changes");
      syncResult.settingsDiffResult = settingsDiffResult
    }

    return syncResult;
  } catch (error) {
    throw new Error("Sync push dry run failed: " + error.message);
  }
}

// Use existing CLI sync pull
async function executeCliSyncPull(
  workspace_id: string,
  repository_path: string,
  repo_resource: any,
  clonedBranchName: string,
  settings_json?: string
) {
  try {
    // Let the CLI handle cleanup - it knows best how to manage the local folder
    // Initialize wmill.yaml if needed
    console.log("DEBUG: Initializing with default settings");

    // Check if wmill.yaml exists in the git repo
    let wmillYamlExists = existsSync("wmill.yaml");
    let settingsDiffResult = {}
    if (!wmillYamlExists) {
      console.log(
        "DEBUG: No wmill.yaml found, initializing with default settings"
      );

      // Run wmill init with default settings
      await wmill_run(
        null,
        "init",
        "--use-default",
        "--token",
        process.env["WM_TOKEN"] ?? "",
        "--base-url",
        process.env["BASE_URL"] + "/",
        "--workspace",
        workspace_id
      );

      console.log("DEBUG: wmill.yaml initialized with defaults");


      // Step 1: Check if wmill.yaml settings would change with gitsync-settings pull --diff
      console.log("DEBUG: Checking wmill.yaml changes with gitsync-settings pull --diff");
      const settingsDiffArgs = [
        null,
        "gitsync-settings",
        "pull",
        "--diff",
        "--repository",
        repository_path,
        "--workspace",
        workspace_id,
        "--replace",
        "--json-output"
      ];

      if (settings_json) {
        settingsDiffArgs.push("--with-backend-settings", settings_json);
      }

      settingsDiffArgs.push(
        "--token",
        process.env["WM_TOKEN"] ?? "",
        "--base-url",
        process.env["BASE_URL"] + "/"
      );

      settingsDiffResult = await wmill_run(...settingsDiffArgs);
      console.log("DEBUG: Settings diff result:", settingsDiffResult);

      // Step 2: Pull settings from backend (actual update)
      console.log("DEBUG: Pulling git-sync settings from backend");
      const settingsArgs = [
        null,
        "gitsync-settings",
        "pull",
        "--repository",
        repository_path,
        "--workspace",
        workspace_id,
        "--replace",
      ];

      if (settings_json) {
        settingsArgs.push("--with-backend-settings", settings_json);
      }

      settingsArgs.push(
        "--token",
        process.env["WM_TOKEN"] ?? "",
        "--base-url",
        process.env["BASE_URL"] + "/"
      );

      await wmill_run(...settingsArgs);
      console.log("DEBUG: Git-sync settings pulled successfully");
    }

    const args = [
      "sync",
      "pull",
      "--yes",
      "--workspace",
      workspace_id,
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/",
      "--repository",
      repository_path,
    ];

    await wmill_run(null, ...args);

    // Commit and push
    await git_push(
      "Initialize windmill sync repo",
      repo_resource,
      clonedBranchName
    );
    await delete_pgp_keys();

    return { success: true, message: "CLI sync pull completed" };
  } catch (error) {
    const errorMessage = error.message || error.toString();
    throw new Error("Sync pull failed: " + errorMessage);
  }
}

// Use existing CLI sync push
async function executeCliSyncPush(
  workspace_id: string,
  repository_path: string,
  repo_resource: any,
  settings_json?: string
) {
  try {
    // Step 1: Get git repo settings using gitsync-settings push --diff
    console.log("DEBUG: Getting git repo settings with gitsync-settings push --diff");
    const settingsArgs = [
      undefined,
      "gitsync-settings",
      "push",
      "--diff",
      "--repository",
      repository_path,
      "--workspace",
      workspace_id,
      "--json-output"
    ];

    settingsArgs.push(
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/"
    );

    const settingsResult = await wmill_run(...settingsArgs);
    console.log("DEBUG: Settings result:", settingsResult);

    // Step 2: Run normal sync push
    console.log("DEBUG: Running sync push");
    const syncArgs = [
      "sync",
      "push",
      "--yes",
      "--json-output",
      "--workspace",
      workspace_id,
      "--token",
      process.env["WM_TOKEN"] ?? "",
      "--base-url",
      process.env["BASE_URL"] + "/",
      "--repository",
      repository_path,
    ];

    const syncResult = await wmill_run(null, ...syncArgs);
    console.log("DEBUG: Sync result:", syncResult);

    // Step 3: Return combined result with settings_json for UI application
    const result = {
      ...syncResult,
      success: true,
      message: "CLI sync push completed",
      settings_json: settingsResult?.local
    };

    console.log("DEBUG: Combined result with settings_json:", result);
    return result;
  } catch (error) {
    throw new Error("Sync push failed: " + error.message);
  }
}

function get_fork_branch_name(w_id: string, originalBranch: string): string {
  if (w_id.startsWith(FORKED_WORKSPACE_PREFIX)) {
    return w_id.replace(FORKED_WORKSPACE_PREFIX, `${FORKED_BRANCH_PREFIX}/${originalBranch}/`);
  }
  return w_id;
}

// Clone repo and optionally enter subfolder
async function git_clone(
  cwd: string,
  repo_resource: any,
  isPull: boolean,
  workspace_id: string
): Promise<{ repo_name: string; safeDirectoryPath: string; clonedBranchName: string }> {
  let repo_url = repo_resource.url;
  const subfolder = repo_resource.folder ?? "";
  let branch = repo_resource.branch ?? "";
  const repo_name = basename(repo_url, ".git");

  const azureMatch = repo_url.match(/AZURE_DEVOPS_TOKEN\((?<url>.+)\)/);
  if (azureMatch) {
    console.log("Fetching Azure DevOps access token...");
    const azureResource = await wmillclient.getResource(azureMatch.groups.url);
    const response = await fetch(
      `https://login.microsoftonline.com/${azureResource.azureTenantId}/oauth2/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: azureResource.azureClientId,
          client_secret: azureResource.azureClientSecret,
          grant_type: "client_credentials",
          resource: "499b84ac-1321-427f-aa17-267ca6975798/.default",
        }),
      }
    );
    const { access_token } = await response.json();
    repo_url = repo_url.replace(azureMatch[0], access_token);
  }

  const args = ["clone", "--quiet", "--depth", "1"];
  if (workspace_id.startsWith(FORKED_WORKSPACE_PREFIX)) args.push("--no-single-branch");
  if (subfolder !== "") args.push("--sparse");
  if (branch !== "") args.push("--branch", branch);
  args.push(repo_url, repo_name);

  try {
    await sh_run(-1, "git", ...args);
  } catch (error) {
    const errorString = error.toString();
    // If cloning failed because the branch doesn't exist (empty repo case)
    if (branch !== "" && errorString.includes("Remote branch") && errorString.includes("not found")) {
      console.log(`DEBUG: Branch ${branch} not found, cloning without branch specification for empty repo`);
      // Retry clone without branch specification
      const fallbackArgs = ["clone", "--quiet", "--depth", "1"];
      if (subfolder !== "") fallbackArgs.push("--sparse");
      fallbackArgs.push(repo_url, repo_name);
      await sh_run(-1, "git", ...fallbackArgs);
    } else {
      throw error;
    }
  }

  const fullPath = join(cwd, repo_name);
  process.chdir(fullPath);

  const safeDirectoryPath = fullPath;
  // Add safe.directory to handle dubious ownership in cloned repo
  try {
    await sh_run(undefined, "git", "config", "--global", "--add", "safe.directory", process.cwd());
  } catch (e) {
    console.log(`Warning: Could not add safe.directory config: ${e}`);
  }

  if (subfolder !== "") {
    await sh_run(undefined, "git", "sparse-checkout", "add", subfolder);
    const subfolderPath = join(fullPath, subfolder);

    if (!existsSync(subfolderPath)) {
      if (isPull) {
        // When pulling FROM git, subfolder must exist
        throw new Error(`Subfolder ${subfolder} does not exist.`);
      } else {
        // When pushing TO git, create subfolder if it doesn't exist
        console.log(
          `DEBUG: Creating subfolder ${subfolder} for push operation`
        );
        await sh_run(undefined, "mkdir", "-p", subfolderPath);
      }
    }

    process.chdir(subfolderPath);
  }

  let clonedBranchName = (await sh_run(undefined, "git", "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (workspace_id.startsWith(FORKED_WORKSPACE_PREFIX)) {
    clonedBranchName = get_fork_branch_name(workspace_id, clonedBranchName);
    try {
      await sh_run(undefined, "git", "checkout", "-b", clonedBranchName);
    } catch {
      log.info("Could not create branch, trying to switch to existing branch");
      await sh_run(undefined, "git", "checkout", clonedBranchName);
    }
  }

  return { repo_name, safeDirectoryPath, clonedBranchName };
}

// Shell runner with secret redaction
async function sh_run(
  secret_position: number | undefined,
  cmd: string,
  ...args: string[]
) {
  const nargs = secret_position != undefined ? args.slice() : args;
  if (secret_position && secret_position < 0)
    secret_position = nargs.length - 1 + secret_position;

  let secret: string | undefined = undefined;
  if (secret_position != undefined) {
    nargs[secret_position] = "***";
    secret = args[secret_position];
  }

  console.log(`DEBUG: Running shell command: '${cmd} ${nargs.join(" ")} ...'`);
  try {
    const { stdout, stderr } = await exec(`${cmd} ${args.join(" ")}`);
    if (stdout.length > 0) {
      console.log("DEBUG: Shell stdout:", stdout);
    }
    if (stderr.length > 0) {
      console.log("DEBUG: Shell stderr:", stderr);
    }
    console.log(`DEBUG: Shell command completed successfully: ${cmd}`);
    return stdout;
  } catch (error: any) {
    let errorString = error.toString();
    if (secret) errorString = errorString.replace(secret, "***");
    console.log(`DEBUG: Shell command FAILED: ${cmd}`, errorString);
    throw new Error(
      `SH command '${cmd} ${nargs.join(" ")}' failed: ${errorString}`
    );
  }
}

async function wmill_run(
  secret_position: number | undefined | null,
  ...cmd: string[]
) {
  cmd = cmd.filter((elt) => elt !== "");
  const cmd2 = cmd.slice();
  if (secret_position) {
    cmd2[secret_position] = "***";
  }
  console.log(`DEBUG: Running CLI command: 'wmill ${cmd2.join(" ")} ...'`);

  // Capture CLI output to parse JSON response
  const originalLog = console.log;
  let cliOutput = "";
  console.log = (msg: string) => {
    cliOutput += msg + "\n";
    originalLog(msg);
  };

  try {
    await wmill.parse(cmd);
    console.log = originalLog;
    console.log("DEBUG: CLI command executed successfully");
  } catch (error) {
    console.log = originalLog;
    console.log("DEBUG: CLI command execution failed:", error);
    throw error;
  }
  // END capture log

  console.log("DEBUG: Captured CLI output length:", cliOutput.length);
  console.log("DEBUG: Raw CLI output:", cliOutput);

  try {
    console.log("DEBUG: Attempting to parse CLI output as JSON...");

    // Find the first occurrence of '{' which indicates the start of JSON
    const jsonStartIndex = cliOutput.indexOf('{');
    if (jsonStartIndex === -1) {
      console.log("DEBUG: No JSON found in CLI output");
      return {};
    }

    // Extract everything from the first '{' to the end
    const jsonString = cliOutput.substring(jsonStartIndex).trim();
    console.log("DEBUG: Extracted JSON string:", jsonString);

    const res = JSON.parse(jsonString);
    console.log("DEBUG: Successfully parsed JSON result:", res);
    return res;
  } catch (e) {
    console.log("DEBUG: Failed to parse CLI output as JSON:", e);
    console.log("DEBUG: Returning empty object");
    return {};
  }
}

async function git_push(
  commit_msg: string,
  repo_resource: any,
  target_branch: string
) {
  console.log("DEBUG: git_push started", {
    commit_msg,
    target_branch,
    has_gpg_key: !!repo_resource.gpg_key,
  });

  console.log("DEBUG: Setting git user config...");
  await sh_run(
    undefined,
    "git",
    "config",
    "user.email",
    process.env["WM_EMAIL"] ?? ""
  );
  await sh_run(
    undefined,
    "git",
    "config",
    "user.name",
    process.env["WM_USERNAME"] ?? ""
  );

  if (repo_resource.gpg_key) {
    console.log("DEBUG: Setting up GPG signing...");
    await set_gpg_signing_secret(repo_resource.gpg_key);
  }

  try {
    console.log("DEBUG: Adding files to git...");
    await sh_run(undefined, "git", "add", "-A", ":!./.config");
    console.log("DEBUG: Files added successfully");
  } catch (error) {
    console.log("DEBUG: Unable to stage files:", error);
  }

  try {
    console.log("DEBUG: Checking for changes to commit...");
    await sh_run(undefined, "git", "diff", "--cached", "--quiet");
    console.log("DEBUG: No changes detected, returning no changes status");
    return { status: "no changes pushed" };
  } catch {
    console.log("DEBUG: Changes detected, proceeding with commit...");
    await sh_run(undefined, "git", "commit", "-m", `"${commit_msg}"`);
    console.log("DEBUG: Commit completed successfully");

    try {
      console.log("DEBUG: Attempting first push...");
      await sh_run(undefined, "git", "push", "--set-upstream", "origin", target_branch);
      console.log("DEBUG: First push succeeded");
      return { status: "changes pushed" };
    } catch (e) {
      const errorString = e.toString();

      // Check if this is an empty repository error (no commits/branches yet)
      if (errorString.includes("src refspec") && errorString.includes("does not match any")) {
        console.log("DEBUG: Empty repository detected - setting up initial branch and push");
        try {
          // For empty repositories, we need to set up the branch properly
          // Set the current branch to the target branch name
          await sh_run(undefined, "git", "branch", "-M", target_branch);
          console.log(`DEBUG: Set branch to ${target_branch}`);

          // Push with upstream to create the initial branch
          await sh_run(undefined, "git", "push", "-u", "origin", target_branch);
          console.log(`DEBUG: Initial push to ${target_branch} branch succeeded`);
          return { status: "changes pushed" };
        } catch (initialPushError) {
          console.log("DEBUG: Initial push setup failed:", initialPushError);
          throw initialPushError;
        }
      }

      console.log("DEBUG: First push failed, attempting rebase and retry:", e);
      try {
        await sh_run(undefined, "git", "pull", "--rebase");
        console.log("DEBUG: Rebase completed, attempting second push...");
        await sh_run(undefined, "git", "push", "--set-upstream", "origin", target_branch);
        console.log("DEBUG: Second push succeeded");
        return { status: "changes pushed" };
      } catch (retryError) {
        const retryErrorString = retryError.toString();

        // Check if the retry failed due to empty repository (refs/heads/main doesn't exist)
        if (retryErrorString.includes("no such ref was fetched") ||
            retryErrorString.includes("couldn't find remote ref")) {
          console.log("DEBUG: Retry failed due to empty repository - setting up initial branch and push");
          try {
            // Set the current branch to the target branch name
            await sh_run(undefined, "git", "branch", "-M", target_branch);
            console.log(`DEBUG: Set branch to ${target_branch}`);

            // Push with upstream to create the initial branch
            await sh_run(undefined, "git", "push", "-u", "origin", target_branch);
            console.log(`DEBUG: Initial push to ${target_branch} branch after retry succeeded`);
            return { status: "changes pushed" };
          } catch (finalPushError) {
            console.log("DEBUG: Final push attempt failed:", finalPushError);
            throw finalPushError;
          }
        }

        console.log("DEBUG: Second push also failed:", retryError);
        throw retryError;
      }
    }
  }
}

async function set_gpg_signing_secret(gpg_key: GpgKey) {
  const gpg_path = "/tmp/gpg";
  await sh_run(undefined, "mkdir", "-p", gpg_path);
  await sh_run(undefined, "chmod", "700", gpg_path);
  process.env.GNUPGHOME = gpg_path;

  const formatted = gpg_key.private_key.replace(
    /(-----BEGIN PGP PRIVATE KEY BLOCK-----)([\s\S]*?)(-----END PGP PRIVATE KEY BLOCK-----)/,
    (_, header, body, footer) =>
      header + "\n\n" + body.replace(/ ([^\s])/g, "\n$1").trim() + "\n" + footer
  );

  try {
    await sh_run(
      1,
      "bash",
      "-c",
      `cat <<EOF | gpg --batch --import \n${formatted}\nEOF`
    );
  } catch {
    throw new Error("Failed to import GPG key!");
  }

  const keyList = await sh_run(
    undefined,
    "gpg",
    "--list-secret-keys",
    "--with-colons",
    "--keyid-format=long"
  );
  const match = keyList.match(
    /sec:[^:]*:[^:]*:[^:]*:([A-F0-9]+):.*\nfpr:::::::::([A-F0-9]{40}):/
  );
  if (!match) throw new Error("Failed to extract GPG Key ID and Fingerprint");

  const keyId = match[1];
  gpgFingerprint = match[2];

  if (gpg_key.passphrase) {
    await sh_run(
      1,
      "bash",
      "-c",
      `echo dummy | gpg --batch --pinentry-mode loopback --passphrase '${gpg_key.passphrase}' --status-fd=2 -bsau ${keyId}`
    );
  }

  await sh_run(undefined, "git", "config", "user.signingkey", keyId);
  await sh_run(undefined, "git", "config", "commit.gpgsign", "true");
}

async function delete_pgp_keys() {
  if (gpgFingerprint) {
    await sh_run(
      undefined,
      "gpg",
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--delete-secret-key",
      gpgFingerprint
    );
    await sh_run(
      undefined,
      "gpg",
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--delete-key",
      gpgFingerprint
    );
  }
}

async function get_gh_app_token() {
  const workspace = process.env["WM_WORKSPACE"];
  const jobToken = process.env["WM_TOKEN"];
  const baseUrl =
    process.env["BASE_INTERNAL_URL"] ??
    process.env["BASE_URL"] ??
    "http://localhost:8000";
  const url = `${baseUrl}/api/w/${workspace}/github_app/token`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jobToken}`,
    },
    body: JSON.stringify({ job_token: jobToken }),
  });

  if (!response.ok)
    throw new Error(`GitHub App token error: ${response.statusText}`);
  const data = await response.json();
  return data.token;
}

function prependTokenToGitHubUrl(gitHubUrl: string, installationToken: string) {
  const url = new URL(gitHubUrl);
  if (url.hostname !== "github.com") throw new Error("Invalid GitHub URL");
  return `https://x-access-token:${installationToken}@github.com${url.pathname}`;
}
