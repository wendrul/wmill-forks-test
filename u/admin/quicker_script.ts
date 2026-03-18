import axios from "axios";

function getenvRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable "${name}" is not set`);
  }
  return value;
}

async function createWorkspace(workspaceName: string, apiBase: string): Promise<void> {
  const token = getenvRequired("WM_TOKEN");
  const workspace = getenvRequired("WM_WORKSPACE");

  const url = `${apiBase}/api/w/${workspace}/workspaces/create_fork`;
  const payload = {
    id: `wm-fork-${workspaceName}`,
    name: workspaceName,
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Failed to create forked workspace: ${response.status} ${response.statusText}`
    );
  }

  console.log("Workspace created");
}

async function main(workspaceName: string, apiBase: string): Promise<void> {
  await createWorkspace(workspaceName, apiBase);
}
