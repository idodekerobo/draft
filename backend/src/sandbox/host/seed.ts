import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { capture, type CaptureResult } from "draft-core/exec";
import { seedSecrets, type SeedSpec } from "./config";
import { redact } from "./log";

const SEED_TIMEOUT_MS = 15 * 60_000;
const TAIL_CHARS = 300;

export interface SeedDeps {
  exec(argv: string[], options?: { cwd?: string }): Promise<CaptureResult>;
  fetch(url: string): Promise<Response>;
}

export class SeedError extends Error {}

/** The real seed deps. Git gets no terminal to prompt on, so a private repo without a credential fails at once. */
export function liveSeedDeps(): SeedDeps {
  return {
    exec: (argv, options) => capture(argv, { timeoutMs: SEED_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0" }, cwd: options?.cwd }),
    fetch: (url) => fetch(url),
  };
}

/**
 * Fills `root` the first time the sandbox starts. Work goes to `root.partial` and is renamed into place at the end,
 * so a stop in the middle never leaves a half-filled workspace that a later start would keep.
 */
export async function prepareWorkspace(seed: SeedSpec, root: string, deps: SeedDeps): Promise<"prepared" | "existing"> {
  if (existsSync(root)) return "existing";
  mkdirSync(dirname(root), { recursive: true });
  const partial = `${root}.partial`;
  rmSync(partial, { recursive: true, force: true });
  try {
    if (seed.kind === "repo") await cloneRepo(seed, partial, deps);
    else if (seed.kind === "routine_run") await startEmptyWorkspace(partial, deps);
    else await restoreSnapshot(seed.url, partial, deps);
    renameSync(partial, root);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  return "prepared";
}

async function cloneRepo(seed: Extract<SeedSpec, { kind: "repo" }>, target: string, deps: SeedDeps): Promise<void> {
  await run(deps, ["git", "clone", "--branch", seed.branch, "--", seed.gitRemote, target], "git clone", seed);
}

/** An empty git repository, so the agent can work in the same way as in a seeded workspace. */
async function startEmptyWorkspace(target: string, deps: SeedDeps): Promise<void> {
  mkdirSync(target, { recursive: true });
  await run(deps, ["git", "init"], "git init", { kind: "routine_run" }, target);
}

/** Extracts the archive, then makes it a git repository with one commit, so the agent can commit from the start. */
async function restoreSnapshot(url: string, target: string, deps: SeedDeps): Promise<void> {
  const response = await deps.fetch(url);
  if (!response.ok) throw new SeedError(`snapshot download failed with status ${response.status}`);
  mkdirSync(target, { recursive: true });
  const archive = `${target}.tar.gz`;
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
  try {
    await run(deps, ["tar", "-xzf", archive, "-C", target, "--no-same-owner"], "snapshot extract", { kind: "snapshot", url });
  } finally {
    rmSync(archive, { force: true });
  }
  const identity = ["-c", "user.name=Draft", "-c", "user.email=draft-sandbox@localhost"];
  const snapshot: SeedSpec = { kind: "snapshot", url };
  await run(deps, ["git", "init"], "git init", snapshot, target);
  await run(deps, ["git", "add", "-A"], "git add", snapshot, target);
  await run(deps, ["git", ...identity, "commit", "--allow-empty", "-m", "Snapshot"], "git commit", snapshot, target);
}

async function run(deps: SeedDeps, argv: string[], label: string, seed: SeedSpec, cwd?: string): Promise<void> {
  const result = await deps.exec(argv, cwd ? { cwd } : undefined);
  if (result.exitCode !== 0) {
    throw new SeedError(`${label} failed with exit ${result.exitCode}: ${redact(result.stderr.slice(-TAIL_CHARS), seedSecrets(seed))}`);
  }
}
