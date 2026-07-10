import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { DRAFT_ROOT, getWorkspacePath, setActiveProfile } from "../config";
import {
  installTeamSkills,
  readSkillManifest,
  uninstallTeamSkills,
  type TeamSkillInput,
} from "../scanner";
import { readSecretsJson, writeEnvSh } from "../secrets";
import {
  readMcpManifest,
} from "./manifest";
import {
  installTeamMcps,
  uninstallTeamMcps,
  type McpSyncOpts,
} from "./mcp-sync";
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
  reason: "personal-name-collision" | "target-modified";
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
  const profileSecrets = readSecretsJson(resolved.statePath);
  const requiredSecretNames = new Set(workspaceMcps.servers.flatMap((entry) => entry.required_secrets));
  writeEnvSh(Object.fromEntries(
    [...requiredSecretNames]
      .filter((name) => typeof profileSecrets[name] === "string" && profileSecrets[name])
      .map((name) => [name, profileSecrets[name]!]),
  ), resolved.envStatePath);
  return result;
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
  const mcpManifest = readMcpManifest(resolved.mcpManifestPath);
  result.removedMcps.push(...Object.entries(mcpManifest.mcps)
    .filter(([, entry]) => entry.kind === "team" && !entry.removed_at)
    .map(([, entry]) => entry.name));
  const mcpResult = await uninstallTeamMcps(profile, mcpOpts(resolved));
  result.errors.push(...mcpResult.errors);
  result.conflicts.push(...mcpResult.conflicts.map((conflict) => ({
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

/**
 * True if another process currently holds the profile-switch lock (and it
 * doesn't look abandoned). The background daemon calls this before its
 * periodic reconcile tick and skips the tick entirely if held.
 *
 * `lockPath` defaults to the real cross-process lock location and is only
 * overridable for tests.
 */
export function isProfileSwitchLockHeld(lockPath: string = PROFILE_SWITCH_LOCK): boolean {
  if (!existsSync(lockPath)) return false;
  if (switchLockIsStaleByAge(lockPath)) return false;
  return switchLockOwnerIsAlive(lockPath);
}

async function acquireProfileSwitchLock(): Promise<void> {
  mkdirSync(join(DRAFT_ROOT, "state"), { recursive: true });
  const deadline = Date.now() + SWITCH_LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      mkdirSync(PROFILE_SWITCH_LOCK);
      writeFileSync(join(PROFILE_SWITCH_LOCK, "owner.json"), JSON.stringify({ pid: process.pid }));
      return;
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

function releaseProfileSwitchLock(): void {
  rmSync(PROFILE_SWITCH_LOCK, { recursive: true, force: true });
}

export async function switchProfileAssets(
  oldProfile: string,
  newProfile: string,
  paths?: Partial<TeamAssetPaths>,
): Promise<ProfileAssetResult> {
  const validation = validateProfileAssets(newProfile, paths);
  if (!validation.ok) throw new TeamAssetValidationError(validation.errors);

  await acquireProfileSwitchLock();
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
    releaseProfileSwitchLock();
  }
}
