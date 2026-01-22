import * as wmillclient from "windmill-client";
import wmill from "windmill-cli";
import { basename } from "node:path";
const util = require("util");
const exec = util.promisify(require("child_process").exec);
import process from "process";

type GpgKey = {
  email: string;
  private_key: string;
  passphrase: string;
};

type PathType =
  | "script"
  | "flow"
  | "app"
  | "folder"
  | "resource"
  | "variable"
  | "resourcetype"
  | "schedule"
  | "user"
  | "group"
  | "httptrigger"
  | "websockettrigger"
  | "kafkatrigger"
  | "natstrigger"
  | "postgrestrigger"
  | "mqtttrigger"
  | "sqstrigger"
  | "gcptrigger";

let gpgFingerprint: string | undefined = undefined;

export async function main(
  workspace_id: string,
  repo_url_resource_path: string,
  path_type: PathType,
  skip_secret = true,
  path: string | undefined,
  parent_path: string | undefined,
  commit_msg: string,
  use_individual_branch = false,
  group_by_folder = false
) {
  let safeDirectoryPath: string | undefined;
  const repo_resource = await wmillclient.getResource(repo_url_resource_path);
  const cwd = process.cwd();
  process.env["HOME"] = ".";
  console.log(
    `Syncing ${path_type} ${path ?? ""} with parent ${parent_path ?? ""}`
  );

  if (repo_resource.is_github_app) {
    const token = await get_gh_app_token();
    const authRepoUrl = prependTokenToGitHubUrl(repo_resource.url, token);
    repo_resource.url = authRepoUrl;
  }

  const { repo_name, safeDirectoryPath: cloneSafeDirectoryPath } = await git_clone(cwd, repo_resource, use_individual_branch);
  safeDirectoryPath = cloneSafeDirectoryPath;
  await move_to_git_branch(
    workspace_id,
    path_type,
    path,
    parent_path,
    use_individual_branch,
    group_by_folder
  );
  const subfolder = repo_resource.folder ?? "";
  const branch_or_default = repo_resource.branch ?? "<DEFAULT>";
  console.log(
    `Pushing to repository ${repo_name} in subfolder ${subfolder} on branch ${branch_or_default}`
  );
  await wmill_sync_pull(
    path_type,
    workspace_id,
    path,
    parent_path,
    skip_secret,
    repo_url_resource_path,
    use_individual_branch,
    repo_resource.branch
  );
  try {
    await git_push(path, parent_path, commit_msg, repo_resource);
  } catch (e) {
    throw e;
  } finally {
    await delete_pgp_keys();
    // Cleanup: remove safe.directory config
    if (safeDirectoryPath) {
      try {
        await sh_run(undefined, "git", "config", "--global", "--unset", "safe.directory", safeDirectoryPath);
      } catch (e) {
        console.log(`Warning: Could not unset safe.directory config: ${e}`);
      }
    }
  }
  console.log("Finished syncing");
  process.chdir(`${cwd}`);
}
async function git_clone(
  cwd: string,
  repo_resource: any,
  use_individual_branch: boolean
): Promise<{ repo_name: string; safeDirectoryPath: string }> {
  // TODO: handle private SSH keys as well
  let repo_url = repo_resource.url;
  const subfolder = repo_resource.folder ?? "";
  const branch = repo_resource.branch ?? "";
  const repo_name = basename(repo_url, ".git");
  const azureMatch = repo_url.match(/AZURE_DEVOPS_TOKEN\((?<url>.+)\)/);
  if (azureMatch) {
    console.log(
      "Requires Azure DevOps service account access token, requesting..."
    );
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
  if (use_individual_branch) {
    args.push("--no-single-branch"); // needed in case the asset branch already exists in the repo
  }
  if (subfolder !== "") {
    args.push("--sparse");
  }
  if (branch !== "") {
    args.push("--branch");
    args.push(branch);
  }
  args.push(repo_url);
  args.push(repo_name);
  await sh_run(-1, "git", ...args);
  try {
    process.chdir(`${cwd}/${repo_name}`);
    const safeDirectoryPath = process.cwd();
    // Add safe.directory to handle dubious ownership in cloned repo
    try {
      await sh_run(undefined, "git", "config", "--global", "--add", "safe.directory", process.cwd());
    } catch (e) {
      console.log(`Warning: Could not add safe.directory config: ${e}`);
    }

    if (subfolder !== "") {
      await sh_run(undefined, "git", "sparse-checkout", "add", subfolder);
      try {
        process.chdir(`${cwd}/${repo_name}/${subfolder}`);
      } catch (err) {
        console.log(
          `Error changing directory to '${cwd}/${repo_name}/${subfolder}'. Error was:\n${err}`
        );
        throw err;
      }
    }
    return { repo_name, safeDirectoryPath };
  } catch (err) {
    console.log(
      `Error changing directory to '${cwd}/${repo_name}'. Error was:\n${err}`
    );
    throw err;
  }
}
async function move_to_git_branch(
  workspace_id: string,
  path_type: PathType,
  path: string | undefined,
  parent_path: string | undefined,
  use_individual_branch: boolean,
  group_by_folder: boolean
) {
  if (!use_individual_branch || path_type === "user" || path_type === "group") {
    return;
  }
  const branchName = group_by_folder
    ? `wm_deploy/${workspace_id}/${(path ?? parent_path)
        ?.split("/")
        .slice(0, 2)
        .join("__")}`
    : `wm_deploy/${workspace_id}/${path_type}/${(
        path ?? parent_path
      )?.replaceAll("/", "__")}`;
  try {
    await sh_run(undefined, "git", "checkout", branchName);
  } catch (err) {
    console.log(
      `Error checking out branch ${branchName}. It is possible it doesn't exist yet, tentatively creating it... Error was:\n${err}`
    );
    try {
      await sh_run(undefined, "git", "checkout", "-b", branchName);
      await sh_run(
        undefined,
        "git",
        "config",
        "--add",
        "--bool",
        "push.autoSetupRemote",
        "true"
      );
    } catch (err) {
      console.log(
        `Error checking out branch '${branchName}'. Error was:\n${err}`
      );
      throw err;
    }
  }
  console.log(`Successfully switched to branch ${branchName}`);
}
async function git_push(
  path: string | undefined,
  parent_path: string | undefined,
  commit_msg: string,
  repo_resource: any
) {
  let user_email = process.env["WM_EMAIL"] ?? "";
  let user_name = process.env["WM_USERNAME"] ?? "";

  if (repo_resource.gpg_key) {
    await set_gpg_signing_secret(repo_resource.gpg_key);
    // Configure git with GPG key email for signing
    await sh_run(
      undefined,
      "git",
      "config",
      "user.email",
      repo_resource.gpg_key.email
    );
    await sh_run(undefined, "git", "config", "user.name", user_name);
  } else {
    await sh_run(undefined, "git", "config", "user.email", user_email);
    await sh_run(undefined, "git", "config", "user.name", user_name);
  }

  if (path !== undefined && path !== null && path !== "") {
    try {
      await sh_run(undefined, "git", "add", "wmill-lock.yaml", `${path}**`);
    } catch (e) {
      console.log(`Unable to stage files matching ${path}**, ${e}`);
    }
  }
  if (parent_path !== undefined && parent_path !== null && parent_path !== "") {
    try {
      await sh_run(
        undefined,
        "git",
        "add",
        "wmill-lock.yaml",
        `${parent_path}**`
      );
    } catch (e) {
      console.log(`Unable to stage files matching ${parent_path}, ${e}`);
    }
  }
  try {
    await sh_run(undefined, "git", "diff", "--cached", "--quiet");
  } catch {
    // git diff returns exit-code = 1 when there's at least one staged changes
    const commitArgs = ["git", "commit"];

    // Always use --author to set consistent authorship
    commitArgs.push("--author", `"${user_name} <${user_email}>"`);
    commitArgs.push(
      "-m",
      `"${commit_msg == undefined || commit_msg == "" ? "no commit msg" : commit_msg}"`
    );

    await sh_run(undefined, ...commitArgs);
    try {
      await sh_run(undefined, "git", "push", "--porcelain");
    } catch (e) {
      console.log(`Could not push, trying to rebase first: ${e}`);
      await sh_run(undefined, "git", "pull", "--rebase");
      await sh_run(undefined, "git", "push", "--porcelain");
    }
    return;
  }
  console.log("No changes detected, nothing to commit. Returning...");
}
async function sh_run(
  secret_position: number | undefined,
  cmd: string,
  ...args: string[]
) {
  const nargs = secret_position != undefined ? args.slice() : args;
  if (secret_position && secret_position < 0) {
    secret_position = nargs.length - 1 + secret_position;
  }
  let secret: string | undefined = undefined;
  if (secret_position != undefined) {
    nargs[secret_position] = "***";
    secret = args[secret_position];
  }

  console.log(`Running '${cmd} ${nargs.join(" ")} ...'`);
  const command = exec(`${cmd} ${args.join(" ")}`);
  // new Deno.Command(cmd, {
  //   args: args,
  // });
  try {
    const { stdout, stderr } = await command;
    if (stdout.length > 0) {
      console.log(stdout);
    }
    if (stderr.length > 0) {
      console.log(stderr);
    }
    console.log("Command successfully executed");
    return stdout;
  } catch (error) {
    let errorString = error.toString();
    if (secret) {
      errorString = errorString.replace(secret, "***");
    }
    const err = `SH command '${cmd} ${nargs.join(
      " "
    )}' returned with error ${errorString}`;
    throw Error(err);
  }
}

function regexFromPath(path_type: PathType, path: string) {
  if (path_type == "flow") {
    return `${path}.flow/*`;
  }
  if (path_type == "app") {
    return `${path}.app/*`;
  } else if (path_type == "folder") {
    return `${path}/folder.meta.*`;
  } else if (path_type == "resourcetype") {
    return `${path}.resource-type.*`;
  } else if (path_type == "resource") {
    return `${path}.resource.*`;
  } else if (path_type == "variable") {
    return `${path}.variable.*`;
  } else if (path_type == "schedule") {
    return `${path}.schedule.*`;
  } else if (path_type == "user") {
    return `${path}.user.*`;
  } else if (path_type == "group") {
    return `${path}.group.*`;
  } else if (path_type == "httptrigger") {
    return `${path}.http_trigger.*`;
  } else if (path_type == "websockettrigger") {
    return `${path}.websocket_trigger.*`;
  } else if (path_type == "kafkatrigger") {
    return `${path}.kafka_trigger.*`;
  } else if (path_type == "natstrigger") {
    return `${path}.nats_trigger.*`;
  } else if (path_type == "postgrestrigger") {
    return `${path}.postgres_trigger.*`;
  } else if (path_type == "mqtttrigger") {
    return `${path}.mqtt_trigger.*`;
  } else if (path_type == "sqstrigger") {
    return `${path}.sqs_trigger.*`;
  } else if (path_type == "gcptrigger") {
    return `${path}.gcp_trigger.*`;
  } else {
    return `${path}.*`;
  }
}

async function wmill_sync_pull(
  path_type: PathType,
  workspace_id: string,
  path: string | undefined,
  parent_path: string | undefined,
  skip_secret: boolean,
  repo_url_resource_path: string,
  use_individual_branch: boolean,
  original_branch?: string
) {
  const includes = [];
  if (path !== undefined && path !== null && path !== "") {
    includes.push(regexFromPath(path_type, path));
  }
  if (parent_path !== undefined && parent_path !== null && parent_path !== "") {
    includes.push(regexFromPath(path_type, parent_path));
  }
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
  console.log("Pulling workspace into git repo");
  const args = [
    "sync",
    "pull",
    "--token",
    process.env["WM_TOKEN"] ?? "",
    "--workspace",
    workspace_id,
    "--repository",
    repo_url_resource_path,
    "--yes",
    skip_secret ? "--skip-secrets" : "",
    "--include-schedules",
    "--include-users",
    "--include-groups",
    "--include-triggers",
  ];

  // Only include settings when specifically deploying settings
  if (path_type === "settings" && !use_individual_branch) {
    args.push("--include-settings");
  }

  // Only include key when specifically deploying keys
  if (path_type === "key" && !use_individual_branch) {
    args.push("--include-key");
  }

  args.push("--extra-includes", includes.join(","));

  // If using individual branches, apply promotion settings from original branch
  if (use_individual_branch && original_branch) {
    console.log(`Individual branch deployment detected - using promotion settings from '${original_branch}'`);
    args.push("--promotion", original_branch);
  }

  await wmill_run(3, ...args);
}

async function wmill_run(secret_position: number, ...cmd: string[]) {
  cmd = cmd.filter((elt) => elt !== "");
  const cmd2 = cmd.slice();
  cmd2[secret_position] = "***";
  console.log(`Running 'wmill ${cmd2.join(" ")} ...'`);
  await wmill.parse(cmd);
  console.log("Command successfully executed");
}

// Function to set up GPG signing
async function set_gpg_signing_secret(gpg_key: GpgKey) {
  try {
    console.log("Setting GPG private key for git commits");

    const formattedGpgContent = gpg_key.private_key.replace(
      /(-----BEGIN PGP PRIVATE KEY BLOCK-----)([\s\S]*?)(-----END PGP PRIVATE KEY BLOCK-----)/,
      (_: string, header: string, body: string, footer: string) =>
        header +
        "\n" +
        "\n" +
        body.replace(/ ([^\s])/g, "\n$1").trim() +
        "\n" +
        footer
    );

    const gpg_path = `/tmp/gpg`;
    await sh_run(undefined, "mkdir", "-p", gpg_path);
    await sh_run(undefined, "chmod", "700", gpg_path);
    process.env.GNUPGHOME = gpg_path;
    // process.env.GIT_TRACE = 1;

    try {
      await sh_run(
        1,
        "bash",
        "-c",
        `cat <<EOF | gpg --batch --import \n${formattedGpgContent}\nEOF`
      );
    } catch (e) {
      // Original error would contain sensitive data
      throw new Error("Failed to import GPG key!");
    }

    const listKeysOutput = await sh_run(
      undefined,
      "gpg",
      "--list-secret-keys",
      "--with-colons",
      "--keyid-format=long"
    );

    const keyInfoMatch = listKeysOutput.match(
      /sec:[^:]*:[^:]*:[^:]*:([A-F0-9]+):.*\nfpr:::::::::([A-F0-9]{40}):/
    );

    if (!keyInfoMatch) {
      throw new Error("Failed to extract GPG Key ID and Fingerprint");
    }

    const keyId = keyInfoMatch[1];
    gpgFingerprint = keyInfoMatch[2];

    if (gpg_key.passphrase) {
      // This is adummy command to unlock the key
      // with passphrase to load it into agent
      await sh_run(
        1,
        "bash",
        "-c",
        `echo "dummy" | gpg --batch --pinentry-mode loopback --passphrase '${gpg_key.passphrase}' --status-fd=2 -bsau ${keyId}`
      );
    }

    // Configure Git to use the extracted key
    await sh_run(undefined, "git", "config", "user.signingkey", keyId);
    await sh_run(undefined, "git", "config", "commit.gpgsign", "true");
    console.log(`GPG signing configured with key ID: ${keyId} `);
  } catch (e) {
    console.error(`Failure while setting GPG key: ${e} `);
    await delete_pgp_keys();
  }
}

async function delete_pgp_keys() {
  console.log("deleting gpg keys");
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
      "--delete-key",
      "--pinentry-mode",
      "loopback",
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
    body: JSON.stringify({
      job_token: jobToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Error: ${response.statusText}`);
  }

  const data = await response.json();

  return data.token;
}

function prependTokenToGitHubUrl(gitHubUrl: string, installationToken: string) {
  if (!gitHubUrl || !installationToken) {
    throw new Error("Both GitHub URL and Installation Token are required.");
  }

  try {
    const url = new URL(gitHubUrl);

    // GitHub repository URL should be in the format: https://github.com/owner/repo.git
    if (url.hostname !== "github.com") {
      throw new Error(
        "Invalid GitHub URL. Must be in the format 'https://github.com/owner/repo.git'."
      );
    }

    // Convert URL to include the installation token
    return `https://x-access-token:${installationToken}@github.com${url.pathname}`;
  } catch (e) {
    const error = e as Error;
    throw new Error(`Invalid URL: ${error.message}`);
  }
}
