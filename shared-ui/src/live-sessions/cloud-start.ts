/** Checks and tidies what a person types for a cloud session. The same rules run again on the server. */

const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const SSH_REMOTE = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const MAX_REMOTE_CHARS = 500;

/** A GitHub SSH remote as the https address the cloud session clones. Any other value comes back trimmed, to be checked. */
export function cloudRepoFromRemote(remote: string): string {
  const value = remote.trim().replace(/\/+$/, "");
  const ssh = SSH_REMOTE.exec(value);
  return ssh ? `https://github.com/${ssh[1]!.replace(/\.git$/, "")}` : value;
}

/** The message for a repository address that a cloud session cannot clone, or null when it can (or is still empty). */
export function repoProblem(value: string): string | null {
  const repo = value.trim();
  if (!repo) return null;
  const match = GITHUB_REPO.exec(repo);
  const name = match?.[2]?.replace(/\.git$/, "");
  const usable = repo.length <= MAX_REMOTE_CHARS && !!name && name !== "." && name !== "..";
  return usable ? null : "Use a GitHub repository address, such as https://github.com/owner/repo.";
}

/** A branch name that git accepts and that cannot read as an option. Null when it is usable or still empty. */
export function branchProblem(value: string): string | null {
  const branch = value.trim();
  if (!branch) return null;
  const usable =
    BRANCH.test(branch) && !branch.includes("..") && !branch.includes("//") && !branch.endsWith("/") && !branch.endsWith(".") && !branch.endsWith(".lock");
  return usable ? null : "Use a branch name, such as main.";
}

/** Where a cloud start failure is shown: under the field it is about, or with the other general messages. */
export type CloudStartField = "repo" | "branch" | "network" | "agent" | "general";

export interface CloudStartFailure {
  field: CloudStartField;
  message: string;
}

const GENERAL_FAILURE: CloudStartFailure = { field: "general", message: "The cloud session could not start. Try again." };

const FAILURES: Record<string, CloudStartFailure> = {
  invalid_seed: { field: "repo", message: "Draft cloud could not use this repository or branch. Check both." },
  invalid_network: { field: "network", message: "That network setting is not supported." },
  harness_not_supported: { field: "agent", message: "Cloud sessions run Claude Code only." },
  unknown_model: { field: "agent", message: "Choose a model from the list." },
  unknown_reasoning_effort: { field: "agent", message: "Choose a reasoning effort from the list." },
  claude_not_connected: { field: "general", message: "This workspace has no Claude Code login. Connect Claude Code, then try again." },
  signed_out: { field: "general", message: "Sign in to Draft Cloud first." },
  start_failed: GENERAL_FAILURE,
};

/** Where the cloud seed comes from. A snapshot has no repository or branch field to point at. */
export type CloudStartSource = "repo" | "snapshot";

/** Snapshot failures all show under the form, since the repository fields are not on screen. */
const SNAPSHOT_FAILURES: Record<string, CloudStartFailure> = {
  invalid_seed: { field: "general", message: "Draft cloud could not use this folder. Try again." },
  seed_not_uploaded: { field: "general", message: "The folder did not finish uploading. Try again." },
  snapshot_empty: { field: "general", message: "There is nothing to copy in this folder. Add files, then try again." },
  not_a_folder: { field: "general", message: "Choose a folder to copy." },
  unknown_env_file: { field: "general", message: "The .env files changed. Check the list and try again." },
  snapshot_pack_failed: { field: "general", message: "Draft could not pack this folder. Try again." },
  snapshot_too_large: { field: "general", message: "This folder is too large to copy to Draft cloud." },
  snapshot_upload_failed: { field: "general", message: "The folder could not be uploaded. Try again." },
  seed_upload_url_failed: { field: "general", message: "Draft cloud could not prepare the upload. Try again." },
};

/** The message for an error code from a cloud start. Codes that are not listed get the general message. */
export function cloudStartFailure(code: string, source: CloudStartSource = "repo"): CloudStartFailure {
  const snapshot = source === "snapshot" ? SNAPSHOT_FAILURES[code] : undefined;
  return snapshot ?? FAILURES[code] ?? GENERAL_FAILURE;
}
