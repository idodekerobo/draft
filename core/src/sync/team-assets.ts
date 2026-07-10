import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { DRAFT_ROOT, getWorkspacePath, setActiveProfile } from "../config";
import {
  installPersonalSkills,
  installTeamSkills,
  readSkillManifest,
  uninstallPersonalSkills,
  uninstallTeamSkills,
  type PersonalSkillInput,
  type AssetConflictReason,
  type SkillManifest,
  type TeamSkillInput,
} from "../scanner";
import { readSecretsJson, writeEnvSh } from "../secrets";
import {
  readMcpManifest,
} from "./manifest";
import {
  installPersonalMcps,
  installTeamMcps,
  uninstallPersonalMcps,
  uninstallTeamMcps,
  type McpSyncOpts,
  type PersonalMcpInput,
} from "./mcp-sync";
import type { McpManifest } from "./manifest";
import {
  readWorkspaceMcpManifest,
  WorkspaceMcpValidationError,
} from "./workspace-mcp";

export type TeamAssetInstallState = "installed" | "pending-secrets" | "conflict";

export interface TeamAssetConflict {
  kind: "skill" | "mcp";
  name: string;
  profile: string;
  personalPath?: string;
  reason: AssetConflictReason;
}

export interface MissingMcpSecrets {
  name: string;
  requiredSecrets: string[];
}

export interface ProfileAssetResult {
  profile: string;
  installedSkills: string[];
  installedMcps: string[];
  removedSkills: string[];
  removedMcps: string[];
  conflicts: TeamAssetConflict[];
  missingSecrets: MissingMcpSecrets[];
  errors: string[];
}

export interface TeamAssetPaths {
  workspacesDir: string;
  activeProfileFile: string;
  workspacePath: string;
  claudeSkillsDir: string;
  codexSkillsDir: string;
  claudeConfigPath: string;
  codexConfigPath: string;
  skillManifestPath: string;
  mcpManifestPath: string;
  statePath: string;
  envStatePath: string;
}

export interface ProfileAssetValidationIssue {
  kind: "skill" | "mcp";
  path: string;
  message: string;
}

export interface ProfileAssetValidation {
  ok: boolean;
  errors: ProfileAssetValidationIssue[];
}

export class TeamAssetValidationError extends Error {
  constructor(public readonly errors: ProfileAssetValidationIssue[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    this.name = "TeamAssetValidationError";
  }
}

function resolvePaths(profile: string, paths?: Partial<TeamAssetPaths>): TeamAssetPaths {
  const home = homedir();
  const workspacesDir = paths?.workspacesDir ?? join(home, ".draft", "workspaces");
  const activeProfileFile = paths?.activeProfileFile ?? join(home, ".draft", "active-profile");
  const workspacePath = paths?.workspacePath ?? getWorkspacePath(profile, { workspacesDir, activeProfileFile });
  return {
    workspacesDir,
    activeProfileFile,
    workspacePath,
    claudeSkillsDir: paths?.claudeSkillsDir ?? join(home, ".claude", "skills"),
    codexSkillsDir: paths?.codexSkillsDir ?? join(home, ".codex", "skills"),
    claudeConfigPath: paths?.claudeConfigPath ?? join(home, ".claude.json"),
    codexConfigPath: paths?.codexConfigPath ?? join(home, ".codex", "config.toml"),
    skillManifestPath: paths?.skillManifestPath ?? join(workspacePath, "config", "skill-manifest.json"),
    mcpManifestPath: paths?.mcpManifestPath ?? join(workspacePath, "config", "mcp-manifest.json"),
    statePath: paths?.statePath ?? join(workspacePath, "config"),
    envStatePath: paths?.envStatePath ?? join(home, ".draft", "state"),
  };
}

function discoverWorkspaceSkills(workspacePath: string): TeamSkillInput[] {
  const skillsDir = join(workspacePath, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => ({ name: entry.name, sourcePath: join(skillsDir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Personal skills have no equivalent source-of-truth directory to rescan on
 * every install (unlike team skills, rediscovered live from the workspace
 * skills/ dir) — install-on-switch must read candidates from the profile's
 * own manifest instead. Only "approved" entries are installed: a "pending"
 * or "conflict" personal entry must never get silently installed just
 * because it isn't tombstoned.
 */
function personalSkillsFromManifest(manifest: SkillManifest): PersonalSkillInput[] {
  return Object.values(manifest.skills)
    .filter((entry) => entry.kind === "personal" && entry.status === "approved" && entry.removed_at === null)
    .map((entry) => ({ name: entry.name, agent: entry.source_agent, sourcePath: entry.source_path }));
}

/** Same reasoning as personalSkillsFromManifest, for MCPs — no status field on McpManifestEntry, so removed_at alone gates "active". */
function personalMcpsFromManifest(manifest: McpManifest): PersonalMcpInput[] {
  return Object.values(manifest.mcps)
    .filter((entry) => entry.kind === "personal" && entry.removed_at === null)
    .map((entry) => ({
      id: entry.id, name: entry.name, source_agent: entry.source_agent,
      canonical: entry.sync_canonical, original_config: entry.source_snapshot.original_config,
    }));
}

export function validateProfileAssets(
  profile: string,
  paths?: Partial<TeamAssetPaths>,
): ProfileAssetValidation {
  const resolved = resolvePaths(profile, paths);
  const errors: ProfileAssetValidationIssue[] = [];
  try {
    for (const skill of discoverWorkspaceSkills(resolved.workspacePath)) {
      try {
        if (!lstatSync(skill.sourcePath).isDirectory() || !existsSync(join(skill.sourcePath, "SKILL.md"))) {
          errors.push({ kind: "skill", path: skill.sourcePath, message: "team skill must contain SKILL.md" });
        }
      } catch (error) {
        errors.push({ kind: "skill", path: skill.sourcePath, message: String(error) });
      }
    }
  } catch (error) {
    errors.push({ kind: "skill", path: join(resolved.workspacePath, "skills"), message: String(error) });
  }
  try {
    readWorkspaceMcpManifest(resolved.workspacePath);
  } catch (error) {
    if (error instanceof WorkspaceMcpValidationError) {
      errors.push(...error.errors.map((issue) => ({
        kind: "mcp" as const,
        path: join(resolved.workspacePath, "config", "mcp.json") + issue.path.slice(1),
        message: issue.message,
      })));
    } else {
      errors.push({ kind: "mcp", path: join(resolved.workspacePath, "config", "mcp.json"), message: String(error) });
    }
  }
  return { ok: errors.length === 0, errors };
}

function mcpOpts(paths: TeamAssetPaths): McpSyncOpts {
  return {
    claudeConfigPath: paths.claudeConfigPath,
    codexConfigPath: paths.codexConfigPath,
    manifestPath: paths.mcpManifestPath,
    statePath: paths.statePath,
  };
}

function emptyResult(profile: string): ProfileAssetResult {
  return {
    profile,
    installedSkills: [],
    installedMcps: [],
    removedSkills: [],
    removedMcps: [],
    conflicts: [],
    missingSecrets: [],
    errors: [],
  };
}

export async function installProfileAssets(
  profile: string,
  paths?: Partial<TeamAssetPaths>,
): Promise<ProfileAssetResult> {
  const resolved = resolvePaths(profile, paths);
  const validation = validateProfileAssets(profile, resolved);
  if (!validation.ok) throw new TeamAssetValidationError(validation.errors);
  const result = emptyResult(profile);
  const skills = installTeamSkills(discoverWorkspaceSkills(resolved.workspacePath), profile, {
    claudeSkillsDir: resolved.claudeSkillsDir,
    codexSkillsDir: resolved.codexSkillsDir,
    manifestPath: resolved.skillManifestPath,
  });
  result.installedSkills.push(...skills.installed);
  result.errors.push(...skills.errors);
  result.conflicts.push(...skills.conflicts.map((conflict) => ({
    kind: "skill" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  const personalSkills = installPersonalSkills(
    personalSkillsFromManifest(readSkillManifest(resolved.skillManifestPath)),
    profile,
    {
      claudeSkillsDir: resolved.claudeSkillsDir,
      codexSkillsDir: resolved.codexSkillsDir,
      manifestPath: resolved.skillManifestPath,
    },
  );
  result.installedSkills.push(...personalSkills.installed);
  result.errors.push(...personalSkills.errors);
  result.conflicts.push(...personalSkills.conflicts.map((conflict) => ({
    kind: "skill" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  const workspaceMcps = readWorkspaceMcpManifest(resolved.workspacePath);
  const mcps = await installTeamMcps(
    workspaceMcps.servers,
    resolved.workspacePath,
    profile,
    mcpOpts(resolved),
  );
  result.installedMcps.push(...mcps.installed);
  result.errors.push(...mcps.errors);
  result.missingSecrets.push(...mcps.missing_secrets.map((missing) => ({
    name: missing.name, requiredSecrets: missing.required_secrets,
  })));
  result.conflicts.push(...mcps.conflicts.map((conflict) => ({
    kind: "mcp" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  const personalMcps = await installPersonalMcps(
    personalMcpsFromManifest(readMcpManifest(resolved.mcpManifestPath)),
    profile,
    mcpOpts(resolved),
  );
  result.installedMcps.push(...personalMcps.installed);
  result.errors.push(...personalMcps.errors);
  result.conflicts.push(...personalMcps.conflicts.map((conflict) => ({
    kind: "mcp" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  rebuildEnvSh(profile, resolved);
  return result;
}

/**
 * Rebuild env.sh (the file Codex bearer-auth env vars are sourced from) for
 * whichever profile is active. Required secret names come from both this
 * profile's team MCPs (profile-scoped secrets.json) and its approved
 * personal MCPs (global secrets.json — see installPersonalMcps's doc
 * comment on why personal MCP secrets are deliberately not profile-scoped).
 * Exported so callers outside the install/switch flow — the desktop
 * approveMcps/setMcpSecret RPC handlers — can trigger the same rebuild
 * immediately after a direct approval, not only on the next profile switch.
 */
export function rebuildEnvSh(profile: string, paths?: Partial<TeamAssetPaths>): void {
  const resolved = resolvePaths(profile, paths);
  const workspaceMcps = readWorkspaceMcpManifest(resolved.workspacePath);
  const teamSecretNames = workspaceMcps.servers.flatMap((entry) => entry.required_secrets);

  const mcpManifest = readMcpManifest(resolved.mcpManifestPath);
  const personalSecretNames = Object.values(mcpManifest.mcps)
    .filter((entry) => entry.kind === "personal" && entry.removed_at === null)
    .flatMap((entry) => Object.keys(entry.env_var_mapping));

  const requiredSecretNames = new Set([...teamSecretNames, ...personalSecretNames]);
  const profileSecrets = readSecretsJson(resolved.statePath);
  const globalSecrets = readSecretsJson();

  writeEnvSh(Object.fromEntries(
    [...requiredSecretNames]
      .map((name): [string, string] | undefined => {
        const value = profileSecrets[name] ?? globalSecrets[name];
        return typeof value === "string" && value ? [name, value] : undefined;
      })
      .filter((entry): entry is [string, string] => entry !== undefined),
  ), resolved.envStatePath);
}

export async function uninstallProfileAssets(
  profile: string,
  paths?: Partial<TeamAssetPaths>,
): Promise<ProfileAssetResult> {
  const resolved = resolvePaths(profile, paths);
  const result = emptyResult(profile);
  const skillManifest = readSkillManifest(resolved.skillManifestPath);
  result.removedSkills.push(...Object.entries(skillManifest.skills)
    .filter(([, entry]) => entry.kind === "team" && !entry.removed_at)
    .map(([, entry]) => entry.name));
  const skills = uninstallTeamSkills(profile, {
    claudeSkillsDir: resolved.claudeSkillsDir,
    codexSkillsDir: resolved.codexSkillsDir,
    manifestPath: resolved.skillManifestPath,
  });
  result.errors.push(...skills.errors);
  result.conflicts.push(...skills.conflicts.map((conflict) => ({
    kind: "skill" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  // Filter matches uninstallPersonalSkills's exact criterion (status==="approved"
  // && removed_at===null) — a broader `!entry.removed_at` check would also match
  // pending/conflict personal entries that uninstallPersonalSkills never touches.
  result.removedSkills.push(...Object.values(skillManifest.skills)
    .filter((entry) => entry.kind === "personal" && entry.status === "approved" && entry.removed_at === null)
    .map((entry) => entry.name));
  const personalUninstall = uninstallPersonalSkills(profile, {
    claudeSkillsDir: resolved.claudeSkillsDir,
    codexSkillsDir: resolved.codexSkillsDir,
    manifestPath: resolved.skillManifestPath,
  });
  result.errors.push(...personalUninstall.errors);
  result.conflicts.push(...personalUninstall.conflicts.map((conflict) => ({
    kind: "skill" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  const mcpManifest = readMcpManifest(resolved.mcpManifestPath);
  result.removedMcps.push(...Object.entries(mcpManifest.mcps)
    .filter(([, entry]) => entry.kind === "team" && !entry.removed_at)
    .map(([, entry]) => entry.name));
  const mcpResult = await uninstallTeamMcps(profile, mcpOpts(resolved));
  result.errors.push(...mcpResult.errors);
  result.conflicts.push(...mcpResult.conflicts.map((conflict) => ({
    kind: "mcp" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  result.removedMcps.push(...Object.values(mcpManifest.mcps)
    .filter((entry) => entry.kind === "personal" && entry.removed_at === null)
    .map((entry) => entry.name));
  const personalMcpUninstall = await uninstallPersonalMcps(profile, mcpOpts(resolved));
  result.errors.push(...personalMcpUninstall.errors);
  result.conflicts.push(...personalMcpUninstall.conflicts.map((conflict) => ({
    kind: "mcp" as const, name: conflict.name, profile, reason: conflict.reason,
  })));

  writeEnvSh({}, resolved.envStatePath);
  return result;
}

// ── Profile-switch lock ────────────────────────────────────────────────────
//
// switchProfileAssets does uninstallProfileAssets(old) -> setActiveProfile(new)
// -> installProfileAssets(new). Between the first two steps, the active-profile
// file on disk still names the OLD profile. The background daemon's periodic
// reconcileSkillManifest() pass runs as a separate long-running process; if its
// tick lands in that window, it reads the old (still "active") profile's
// manifest, sees the personal entry we just deactivated (approved, symlink now
// missing — a state that's only supposed to be normal for an INACTIVE
// profile), and "repairs" it by recreating the symlink we just tore down. This
// lock closes that race: the daemon must check it and skip its tick entirely
// while a switch is in flight (a switch completes in milliseconds; the next
// tick a few minutes later simply retries). Mirrors the mkdir-based lock
// pattern in core/src/migrations/runner.ts.

const PROFILE_SWITCH_LOCK = join(DRAFT_ROOT, "state", "profile-switch.lock");
const SWITCH_LOCK_WAIT_MS = 30_000;
const SWITCH_LOCK_STALE_MS = 5 * 60_000;

function switchLockOwnerIsAlive(lockPath: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: number };
    if (!pid) return true;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function switchLockIsStaleByAge(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > SWITCH_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Reads back the acquisition token written by whoever currently holds the lock, if any. */
function switchLockOwnerToken(lockPath: string): string | null {
  try {
    const { token } = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { token?: string };
    return token ?? null;
  } catch {
    return null;
  }
}

/**
 * True if another process currently holds the profile-switch lock (and it
 * doesn't look abandoned). Cheap advisory check only — callers that actually
 * act on the manifest must use `withProfileSwitchLock` instead, since this is
 * a point-in-time read with no exclusion guarantee of its own.
 *
 * `lockPath` defaults to the real cross-process lock location and is only
 * overridable for tests.
 */
export function isProfileSwitchLockHeld(lockPath: string = PROFILE_SWITCH_LOCK): boolean {
  if (!existsSync(lockPath)) return false;
  if (switchLockIsStaleByAge(lockPath)) return false;
  return switchLockOwnerIsAlive(lockPath);
}

/**
 * Blocking acquire with retry-until-timeout, used by switchProfileAssets
 * itself (which needs to actually wait its turn, not skip). Returns the
 * acquisition token — pass it to `releaseProfileSwitchLock` so release is
 * ownership-verified: a stale-takeover means the original holder must never
 * delete the new owner's lock out from under it.
 */
async function acquireProfileSwitchLock(): Promise<string> {
  mkdirSync(join(DRAFT_ROOT, "state"), { recursive: true });
  const deadline = Date.now() + SWITCH_LOCK_WAIT_MS;
  const token = randomUUID();

  while (Date.now() < deadline) {
    try {
      mkdirSync(PROFILE_SWITCH_LOCK);
      writeFileSync(join(PROFILE_SWITCH_LOCK, "owner.json"), JSON.stringify({ pid: process.pid, token }));
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      if (switchLockIsStaleByAge(PROFILE_SWITCH_LOCK) || !switchLockOwnerIsAlive(PROFILE_SWITCH_LOCK)) {
        rmSync(PROFILE_SWITCH_LOCK, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error("Timed out waiting for another Draft process to finish a profile switch.");
}

/**
 * Ownership-verified release: only removes the lock directory if it still
 * contains the token this caller was granted on acquire. If a stale-takeover
 * happened in the meantime (this caller's own liveness lapsed and someone
 * else grabbed the lock), the token on disk will belong to the new owner —
 * release becomes a no-op instead of destroying their lock.
 */
/** Exported only for tests exercising the ownership-verified release invariant directly. */
export function releaseProfileSwitchLock(token: string, lockPath: string = PROFILE_SWITCH_LOCK): void {
  if (switchLockOwnerToken(lockPath) !== token) return;
  rmSync(lockPath, { recursive: true, force: true });
}

/**
 * Single non-blocking acquire attempt: if the lock is free, run `fn()` under
 * it and always release (ownership-verified) afterward, returning its
 * result. If the lock is already held by a live process, return `undefined`
 * immediately without running `fn()` — callers that reconcile/repair state
 * should skip their tick entirely rather than wait, since a switch completes
 * in milliseconds and the next tick will simply retry. This is the primitive
 * every write-capable reconcile/watcher call site must use instead of the
 * bare `isProfileSwitchLockHeld()` check-then-act pattern, which does not by
 * itself provide mutual exclusion.
 */
export async function withProfileSwitchLock<T>(
  fn: () => T | Promise<T>,
  lockPath: string = PROFILE_SWITCH_LOCK,
): Promise<T | undefined> {
  mkdirSync(join(lockPath, ".."), { recursive: true });
  const token = randomUUID();
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return undefined;
  }
  try {
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token }));
    return await fn();
  } finally {
    releaseProfileSwitchLock(token, lockPath);
  }
}

export async function switchProfileAssets(
  oldProfile: string,
  newProfile: string,
  paths?: Partial<TeamAssetPaths>,
): Promise<ProfileAssetResult> {
  const validation = validateProfileAssets(newProfile, paths);
  if (!validation.ok) throw new TeamAssetValidationError(validation.errors);

  const lockToken = await acquireProfileSwitchLock();
  try {
    const removed = await uninstallProfileAssets(oldProfile, paths);
    const activationPaths = resolvePaths(newProfile, paths);
    const activation = setActiveProfile(newProfile, {
      workspacesDir: activationPaths.workspacesDir,
      activeProfileFile: activationPaths.activeProfileFile,
    });
    if (!activation.ok) {
      await installProfileAssets(oldProfile, paths);
      throw new Error(`Failed to activate profile "${newProfile}": ${activation.reason}`);
    }
    try {
      const installed = await installProfileAssets(newProfile, paths);
      return {
        ...installed,
        removedSkills: removed.removedSkills,
        removedMcps: removed.removedMcps,
        conflicts: [...removed.conflicts, ...installed.conflicts],
        errors: [...removed.errors, ...installed.errors],
      };
    } catch (error) {
      setActiveProfile(oldProfile, {
        workspacesDir: activationPaths.workspacesDir,
        activeProfileFile: activationPaths.activeProfileFile,
      });
      await installProfileAssets(oldProfile, paths);
      throw error;
    }
  } finally {
    releaseProfileSwitchLock(lockToken);
  }
}
