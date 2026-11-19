import { posix } from "node:path";

/** What the sandbox host is told at start. A missing or malformed value stops the host before it does any work. */
export type SeedSpec = { kind: "repo"; gitRemote: string; branch: string } | { kind: "snapshot"; url: string };

export interface HostConfig {
  apiBase: string;
  runToken: string;
  sessionId: string;
  workspaceId: string;
  home: string;
  seed: SeedSpec;
}

export class HostConfigError extends Error {}

const REQUIRED = ["DRAFT_API_BASE_URL", "DRAFT_RUN_TOKEN", "DRAFT_SESSION_ID", "DRAFT_WORKSPACE_ID", "DRAFT_SEED", "HOME"];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;
const MAX_REMOTE_CHARS = 2048;
// https or ssh URLs, or scp-style `user@host:path`. A name that starts with "-" could be read as a git option.
const REMOTE_PATTERN = /^(?:(?:https|ssh):\/\/[^\s-]\S*|[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:\S+)$/;

export const cloudHostId = (sessionId: string) => `cloud:${sessionId}`;

/** HOME holds the harness login and the workspace on the sandbox volume, so it must be /data or under it. */
export function isVolumeHome(home: string): boolean {
  const normalized = posix.normalize(home).replace(/\/+$/, "");
  return normalized === "/data" || normalized.startsWith("/data/");
}

export function parseHostConfig(env: Record<string, string | undefined>): HostConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new HostConfigError(`missing required environment variables: ${missing.join(", ")}`);
  const get = (name: string) => env[name] ?? "";
  return {
    apiBase: parseApiBase(get("DRAFT_API_BASE_URL")),
    runToken: get("DRAFT_RUN_TOKEN"),
    sessionId: parseId("DRAFT_SESSION_ID", get("DRAFT_SESSION_ID")),
    workspaceId: parseId("DRAFT_WORKSPACE_ID", get("DRAFT_WORKSPACE_ID")),
    home: get("HOME"),
    seed: parseSeed(get("DRAFT_SEED")),
  };
}

/** Values the logs must hide: the seed holds a remote that may embed a token, or a signed URL. */
export function seedSecrets(seed: SeedSpec): string[] {
  return seed.kind === "repo" ? [seed.gitRemote] : [seed.url];
}

function parseApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new HostConfigError("DRAFT_API_BASE_URL is not a URL", { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HostConfigError("DRAFT_API_BASE_URL must be an http or https URL");
  return raw.replace(/\/+$/, "");
}

function parseId(name: string, value: string): string {
  if (!ID_PATTERN.test(value)) throw new HostConfigError(`${name} must be letters, digits, "-" or "_"`);
  return value;
}

/** Parses DRAFT_SEED. Error messages name the field, never its value, since the value may hold a credential. */
export function parseSeed(raw: string): SeedSpec {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HostConfigError("DRAFT_SEED is not valid JSON", { cause: error });
  }
  if (!isRecord(value)) throw new HostConfigError("DRAFT_SEED must be a JSON object");
  if (value.kind === "repo") return parseRepoSeed(value);
  if (value.kind === "snapshot") return parseSnapshotSeed(value);
  throw new HostConfigError('DRAFT_SEED kind must be "repo" or "snapshot"');
}

function parseRepoSeed(value: Record<string, unknown>): SeedSpec {
  const { gitRemote, branch } = value;
  if (typeof gitRemote !== "string" || gitRemote.length > MAX_REMOTE_CHARS || !REMOTE_PATTERN.test(gitRemote)) {
    throw new HostConfigError("DRAFT_SEED repo.gitRemote must be an https, ssh or scp-style git remote");
  }
  if (typeof branch !== "string" || !BRANCH_PATTERN.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new HostConfigError("DRAFT_SEED repo.branch is not a valid branch name");
  }
  return { kind: "repo", gitRemote, branch };
}

function parseSnapshotSeed(value: Record<string, unknown>): SeedSpec {
  const { url } = value;
  if (typeof url !== "string") throw new HostConfigError("DRAFT_SEED snapshot.url must be a string");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new HostConfigError("DRAFT_SEED snapshot.url is not a URL", { cause: error });
  }
  if (parsed.protocol !== "https:") throw new HostConfigError("DRAFT_SEED snapshot.url must be https");
  return { kind: "snapshot", url };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
