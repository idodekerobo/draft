import { isEffortFor, isKnownModel } from "draft-core/harnesses";

const CLOUD_HARNESS = "claude";
const MAX_REMOTE_CHARS = 500;
const GITHUB_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export type CloudSeed = { kind: "repo"; gitRemote: string; repo: string; branch: string };

export interface CloudStartInput {
  workspaceId: string;
  ownerUserId: string;
  harness: "claude";
  model: string | null;
  reasoningEffort: string | null;
  network: "restricted" | "open";
  seed: CloudSeed;
}

export type CloudStartParse = { ok: true; input: CloudStartInput } | { ok: false; error: string };

const refuse = (error: string): CloudStartParse => ({ ok: false, error });

/**
 * Checks the body of a cloud session start. The error is the response code. A snapshot seed is well-formed
 * but refused, because no snapshot storage exists yet.
 */
export function parseCloudStart(body: Record<string, unknown>, owner: { workspaceId: string; ownerUserId: string }): CloudStartParse {
  if ((body.harness ?? CLOUD_HARNESS) !== CLOUD_HARNESS) return refuse("harness_not_supported");

  const model = body.model ?? null;
  if (typeof model !== "string" && model !== null) return refuse("unknown_model");
  if (!isKnownModel(CLOUD_HARNESS, model)) return refuse("unknown_model");

  const reasoningEffort = body.reasoningEffort ?? null;
  if (typeof reasoningEffort !== "string" && reasoningEffort !== null) return refuse("unknown_reasoning_effort");
  if (!isEffortFor(CLOUD_HARNESS, model, reasoningEffort)) return refuse("unknown_reasoning_effort");

  const network = body.network ?? "restricted";
  if (network !== "restricted" && network !== "open") return refuse("invalid_network");

  const seed = parseSeed(body.seed, owner.workspaceId);
  if (!seed.ok) return seed;
  return {
    ok: true,
    input: { workspaceId: owner.workspaceId, ownerUserId: owner.ownerUserId, harness: CLOUD_HARNESS, model, reasoningEffort, network, seed: seed.seed },
  };
}

type SeedParse = { ok: true; seed: CloudSeed } | { ok: false; error: string };

function parseSeed(value: unknown, workspaceId: string): SeedParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "invalid_seed" };
  const seed = value as Record<string, unknown>;

  if (seed.kind === "repo") {
    const remote = parseGitHubRemote(seed.gitRemote);
    if (!remote || !isSafeBranch(seed.branch)) return { ok: false, error: "invalid_seed" };
    return { ok: true, seed: { kind: "repo", gitRemote: remote.gitRemote, repo: remote.repo, branch: seed.branch } };
  }

  if (seed.kind === "snapshot") {
    const key = seed.storageKey;
    const valid = typeof key === "string" && key.length <= MAX_REMOTE_CHARS && key.startsWith(`${workspaceId}/`) && !key.split("/").includes("..");
    return { ok: false, error: valid ? "snapshot_not_supported" : "invalid_seed" };
  }

  return { ok: false, error: "invalid_seed" };
}

/** An https github.com URL of one repository. Returns the URL and "owner/name" for the GitHub token scope. */
function parseGitHubRemote(value: unknown): { gitRemote: string; repo: string } | null {
  if (typeof value !== "string" || value.length > MAX_REMOTE_CHARS) return null;
  const match = GITHUB_REMOTE.exec(value);
  if (!match) return null;
  const owner = match[1]!;
  const name = match[2]!;
  const repoName = name.replace(/\.git$/, "");
  if (repoName === "" || repoName === "." || repoName === "..") return null;
  return { gitRemote: value, repo: `${owner}/${repoName}` };
}

/** A branch name that git accepts and that cannot read as an option. */
function isSafeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BRANCH.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}
