import * as wmillclient from "windmill-client";
import { basename, join } from "node:path";
import { existsSync, rmSync } from "fs";
const util = require("util");
const exec = util.promisify(require("child_process").exec);
import process from "process";
import * as fs from 'fs/promises';

type GitRepository = {
  url: string;
  branch: string;
  folder: string;
  gpg_key: any;
  is_github_app: boolean;
};

export async function main(
  resource_path: string,
  workspace: string,
  git_ssh_identity?: string[],
  commit?: string
) {
  let clonedRepoPath: string | undefined;

  try {
    console.log("Starting git clone and Blob storage upload process");

    // Get the git repository resource
    const repo_resource: GitRepository = await wmillclient.getResource(resource_path);

    if (git_ssh_identity) {
      process.env.GIT_SSH_COMMAND = await get_git_ssh_cmd(git_ssh_identity)
    }

    // Handle GitHub App authentication if needed
    if (repo_resource.is_github_app) {
      const token = await get_gh_app_token();
      repo_resource.url = prependTokenToGitHubUrl(repo_resource.url, token);
    }

    const cwd = process.cwd();
    process.env["HOME"] = ".";
    process.env.GIT_TERMINAL_PROMPT = "0";

    // Clone the repository
    const { repo_name, commitHash } = await git_clone(cwd, repo_resource, commit);
    clonedRepoPath = join(cwd, repo_name);

    // Remove .git directory to avoid uploading git history
    const gitDir = join(clonedRepoPath, ".git");
    if (existsSync(gitDir)) {
      rmSync(gitDir, { recursive: true, force: true });
      console.log("Removed .git directory");
    }

    // Upload to S3
    const s3Path = `gitrepos/${workspace}/${resource_path}/${commitHash}`;
    await uploadDirectoryToS3(clonedRepoPath, s3Path, workspace);

    return {
      success: true,
      message: "Repository cloned and uploaded to S3 successfully",
      s3_path: s3Path,
      commit_hash: commitHash
    };

  } catch (error) {
    console.error("Error in git clone and upload:", error);
    throw error;
  } finally {
    // Clean up cloned repository
    if (clonedRepoPath && existsSync(clonedRepoPath)) {
      rmSync(clonedRepoPath, { recursive: true, force: true });
      console.log("Cleaned up cloned repository");
    }
  }
}

async function get_git_ssh_cmd(git_ssh_identity: string[]): Promise<string> {
  const sshIdFiles = await Promise.all(
    git_ssh_identity.map(async (varPath, i) => {
      const filePath = `./ssh_id_priv_${i}`;

      try {
        // Get variable value using windmill
        let content = await wmillclient.getVariable(varPath);
        content += '\n';

        // Write file with content
        await fs.writeFile(filePath, content, { encoding: 'utf8' });

        // Set file permissions to 0o600 (read/write for owner only)
        await fs.chmod(filePath, 0o600);

        // Escape single quotes for shell command
        const escapedPath = filePath.replace(/'/g, "'\\''");
        return ` -i '${escapedPath}'`;
      } catch (error) {
        console.error(
          `Variable ${varPath} not found for git ssh identity: ${error}`
        );
        return '';
      }
    })
  );

  const gitSshCmd = `ssh -o StrictHostKeyChecking=no${sshIdFiles.join('')}`;
  return gitSshCmd;
}
async function git_clone(
  cwd: string,
  repo_resource: GitRepository,
  commit?: string,
): Promise<{ repo_name: string; commitHash: string }> {
  if (commit) {
    return git_clone_at_commit(cwd, repo_resource, commit);
  } else {
    return git_clone_at_latest(cwd, repo_resource);
  }
}

async function git_clone_at_commit(
  cwd: string,
  repo_resource: GitRepository,
  commit: string,
): Promise<{ repo_name: string; commitHash: string }> {
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

  const repoPath = join(cwd, repo_name);
  process.chdir(repoPath);

  await fs.mkdir(repoPath, { recursive: true });

  await runCommand(undefined, 'git', 'init', '--quiet', `--initial-branch=${branch}`);

  await runCommand(-1, 'git', 'remote', 'add', 'origin', repo_url);

  await runCommand(undefined, 'git', 'fetch', '--depth=1', '--quiet', 'origin', commit);

  await runCommand(undefined, 'git', 'fetch', '--quiet', 'FETCH_HEAD');

  const commitHash = (await runCommand(undefined, "git", "rev-parse", "HEAD")).trim();

  // Return to original directory
  process.chdir(cwd);

  return { repo_name, commitHash };
}

async function git_clone_at_latest(
  cwd: string,
  repo_resource: GitRepository
): Promise<{ repo_name: string; commitHash: string }> {
  let repo_url = repo_resource.url;
  const subfolder = repo_resource.folder ?? "";
  let branch = repo_resource.branch ?? "";
  const repo_name = basename(repo_url, ".git");

  // Handle Azure DevOps token if needed
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
  if (subfolder !== "") args.push("--sparse");
  if (branch !== "") args.push("--branch", branch);
  args.push(repo_url, repo_name);

  await runCommand(-1, "git", ...args);

  const fullPath = join(cwd, repo_name);
  process.chdir(fullPath);

  if (subfolder !== "") {
    await runCommand(undefined, "git", "sparse-checkout", "add", subfolder);
    const subfolderPath = join(fullPath, subfolder);

    if (!existsSync(subfolderPath)) {
      throw new Error(`Subfolder ${subfolder} does not exist.`);
    }

    process.chdir(subfolderPath);
  }

  // Get the commit hash
  const commitHash = (await runCommand(undefined, "git", "rev-parse", "HEAD")).trim();

  // Return to original directory
  process.chdir(cwd);

  return { repo_name, commitHash };
}

async function uploadDirectoryToS3(
  directoryPath: string,
  s3BasePath: string,
  workspace: string,
) {
  console.log(`Uploading directory ${directoryPath} to S3 path ${s3BasePath}`);

  async function uploadDirRecursive(currentDir: string, currentS3Path: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const s3Key = currentS3Path ? `${currentS3Path}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Recursively upload subdirectory
        await uploadDirRecursive(fullPath, s3Key);
      } else if (entry.isFile()) {
        // Upload file
        const fileContent = fs.readFileSync(fullPath);
        const blob = new Blob([fileContent], { type: 'application/octet-stream' });
        await wmillclient.HelpersService.gitRepoViewerFileUpload({
          workspace,
          fileKey: s3Key,
          requestBody: blob
        });
        console.log(`Uploaded: ${s3Key}`);
      }
    }
  }

  await uploadDirRecursive(directoryPath, s3BasePath);
  console.log("Directory upload completed");
}

function runCommand(secret_position: number | undefined, command: string, ...args: string[]): Promise<string> {
  const nargs = secret_position != undefined ? args.slice() : args;
  if (secret_position && secret_position < 0)
    secret_position = nargs.length - 1 + secret_position;

  let secret: string | undefined = undefined;
  if (secret_position != undefined) {
    nargs[secret_position] = "***";
    secret = args[secret_position];
  }
  console.log(`Running shell command: '${command} ${nargs.join(" ")} ...'`);

  return new Promise((resolve, reject) => {
    const process = spawn(command, args);

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('error', (error) => {
      let errorString = error.toString();
      if (secret) errorString = errorString.replace(secret, "***");
      console.log(`Shell command FAILED: ${cmd}`, errorString);
      const e = new Error(
        `SH command '${cmd} ${nargs.join(" ")}' failed: ${errorString}`
      );
      reject(e);
    });

    process.on('close', (code) => {
      if (stdout.length > 0) {
        console.log("Shell stdout:", stdout);
      }
      if (stderr.length > 0) {
        console.log("Shell stderr:", stderr);
      }
      if (code === 0) {
        console.log(`Shell command completed successfully: ${cmd}`);
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
  });
}

// async function sh_run(
//   secret_position: number | undefined,
//   cmd: string,
//   ...args: string[]
// ) {
//   const nargs = secret_position != undefined ? args.slice() : args;
//   if (secret_position && secret_position < 0)
//     secret_position = nargs.length - 1 + secret_position;
//
//   let secret: string | undefined = undefined;
//   if (secret_position != undefined) {
//     nargs[secret_position] = "***";
//     secret = args[secret_position];
//   }
//
//   console.log(`Running shell command: '${cmd} ${nargs.join(" ")} ...'`);
//   try {
//     const { stdout, stderr } = await exec(`${cmd} ${args.join(" ")}`);
//     if (stdout.length > 0) {
//       console.log("Shell stdout:", stdout);
//     }
//     if (stderr.length > 0) {
//       console.log("Shell stderr:", stderr);
//     }
//     console.log(`Shell command completed successfully: ${cmd}`);
//     return stdout;
//   } catch (error: any) {
//     let errorString = error.toString();
//     if (secret) errorString = errorString.replace(secret, "***");
//     console.log(`Shell command FAILED: ${cmd}`, errorString);
//     throw new Error(
//       `SH command '${cmd} ${nargs.join(" ")}' failed: ${errorString}`
//     );
//   }
// }

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
