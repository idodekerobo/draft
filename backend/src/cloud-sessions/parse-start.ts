import { DEFAULT_HARNESS_ID, adapterSupportsTarget, interactiveAdapterFor, isEffortFor, isHarnessId, isKnownModel, type HarnessId } from "draft-core/harnesses";
import { sessionIdOfSnapshotKey } from "./snapshot-seed";

const MAX_REMOTE_CHARS = 500;
const FOLDER_NAME_MAX_CHARS = 200;
const DEFAULT_FOLDER_NAME = "snapshot";
const GITHUB_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CloudSeed =
  | { kind: "repo"; gitRemote: string; repo: string; branch: string }
  | { kind: "snapshot"; sessionId: string; storageKey: string; folderName: string }
  /** An empty workspace that continues the history of a finished routine run, which is read over Draft's tools. */
  | { kind: "routine_run"; routineSessionId: string }
  | { kind: "empty" };

export interface CloudStartInput {
  workspaceId: string;
  ownerUserId: string;
  harness: HarnessId;
  model: string | null;
  reasoningEffort: string | null;
  network: "restricted" | "open";
  seed: CloudSeed;
}

export type CloudStartParse = { ok: true; input: CloudStartInput } | { ok: false; error: string };

const refuse = (error: string): CloudStartParse => ({ ok: false, error });

/**
 * Checks the body of a cloud session start. The error is the response code. A snapshot seed names its object key,
 * and the session id is the key's session segment. A body sessionId is only a check that it matches.
 */
export function parseCloudStart(body: Record<string, unknown>, owner: { workspaceId: string; ownerUserId: string }): CloudStartParse {
  const harness = body.harness ?? DEFAULT_HARNESS_ID;
  if (!isHarnessId(harness)) return refuse("harness_not_supported");
  const adapter = interactiveAdapterFor(harness);
  if (!adapter || !adapterSupportsTarget(adapter, "sandbox")) return refuse("harness_not_supported");

  const model = body.model ?? null;
  if (typeof model !== "string" && model !== null) return refuse("unknown_model");
  if (!isKnownModel(harness, model)) return refuse("unknown_model");

  const reasoningEffort = body.reasoningEffort ?? null;
  if (typeof reasoningEffort !== "string" && reasoningEffort !== null) return refuse("unknown_reasoning_effort");
  if (!isEffortFor(harness, model, reasoningEffort)) return refuse("unknown_reasoning_effort");

  const network = body.network ?? "restricted";
  if (network !== "restricted" && network !== "open") return refuse("invalid_network");

  const seed = parseSeed(body.seed, body.sessionId, owner.workspaceId);
  if (!seed.ok) return seed;
  return {
    ok: true,
    input: { workspaceId: owner.workspaceId, ownerUserId: owner.ownerUserId, harness, model, reasoningEffort, network, seed: seed.seed },
  };
}

type SeedParse = { ok: true; seed: CloudSeed } | { ok: false; error: string };

function parseSeed(value: unknown, sessionId: unknown, workspaceId: string): SeedParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "invalid_seed" };
  const seed = value as Record<string, unknown>;

  if (seed.kind === "repo") {
    const remote = parseGitHubRemote(seed.gitRemote);
    if (!remote || !isSafeBranch(seed.branch) || sessionId !== undefined) return { ok: false, error: "invalid_seed" };
    return { ok: true, seed: { kind: "repo", gitRemote: remote.gitRemote, repo: remote.repo, branch: seed.branch } };
  }

  if (seed.kind === "empty") {
    if (sessionId !== undefined) return { ok: false, error: "invalid_seed" };
    return { ok: true, seed: { kind: "empty" } };
  }

  // The routine run's session id is inside the seed, so the body has no sessionId for this kind.
  if (seed.kind === "routine_run") {
    if (typeof seed.sessionId !== "string" || !UUID.test(seed.sessionId) || sessionId !== undefined) return { ok: false, error: "invalid_seed" };
    return { ok: true, seed: { kind: "routine_run", routineSessionId: seed.sessionId } };
  }

  if (seed.kind === "snapshot") {
    const key = seed.storageKey;
    const keySession = typeof key === "string" && key.length <= MAX_REMOTE_CHARS ? sessionIdOfSnapshotKey(key, workspaceId) : null;
    if (!keySession || (sessionId !== undefined && sessionId !== keySession)) return { ok: false, error: "invalid_seed" };
    return { ok: true, seed: { kind: "snapshot", sessionId: keySession, storageKey: key as string, folderName: folderNameOf(seed.folderName) } };
  }

  return { ok: false, error: "invalid_seed" };
}

/** The name a snapshot shows in the session list. A missing or unusable name falls back to "snapshot". */
function folderNameOf(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_FOLDER_NAME;
  const name = value.trim();
  return name !== "" && name.length <= FOLDER_NAME_MAX_CHARS && !/\p{Cc}/u.test(name) ? name : DEFAULT_FOLDER_NAME;
}

/** An https github.com URL of one repository. Returns the URL and "owner/name" for the GitHub token scope. */
export function parseGitHubRemote(value: unknown): { gitRemote: string; repo: string } | null {
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
