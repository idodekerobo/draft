// desktop/src/main/watchers/skills.ts — cross-agent skill watcher with approval gate

import { existsSync, mkdirSync, readdirSync, lstatSync, watch } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import {
  detectPending,
  reconcileSkillManifest,
  hashSkillDir,
  scanSkillDirectories,
  installTeamSkills,
  uninstallTeamSkill,
  type PendingSkillEntry,
  type SameNameConflict,
  type ReconcileResult,
  type ScannedSkill,
} from "draft-core/scanner";
import { withProfileSwitchLock } from "draft-core/sync/team-assets";

// 2-second debounce to allow rename detection (disappear + reappear within the window)
const DEBOUNCE_MS = 2_000;
const FALLBACK_POLL_MS = 120_000;

export interface SkillWatchHandlers {
  onSkillsPending: (skills: PendingSkillEntry[]) => void;
  onSkillsConflict: (conflicts: SameNameConflict[]) => void;
  /** Fired when symlinks are created after approval (for UI badge count). */
  onSkillsChanged: (count: number) => void;
  onReconciled: (result: ReconcileResult) => void;
  /** Fired when team skills are installed from the workspace. */
  onTeamSkillsChanged?: (count: number) => void;
}

export interface SkillWatchOptions {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  manifestPath?: string;
  /** Active profile name — used to watch workspace/skills/ and install team skills. */
  activeProfile?: string;
  workspacesDir?: string;
}

let watchers: Array<ReturnType<typeof watch>> = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let started = false;
let currentHandlers: SkillWatchHandlers | null = null;
let currentOptions: SkillWatchOptions | undefined;

// Track known skills by compound key + their directory hash (for rename detection)
let knownSkillKeys = new Set<string>();
let knownHashes = new Map<string, string>(); // "agent:dirPath" → skill_dir_hash

// Track known workspace skills by name (for team skill change detection)
let knownWorkspaceSkillNames = new Set<string>();

function skillKey(skill: ScannedSkill): string {
  return `${skill.agent}:${skill.dirPath}`;
}

function getWorkspaceSkillsDir(options?: SkillWatchOptions): string | null {
  if (!options?.activeProfile) return null;
  const wsDir = options.workspacesDir ?? `${homedir()}/.draft/workspaces`;
  return join(wsDir, options.activeProfile, "skills");
}

function scanWorkspaceSkillNames(workspaceSkillsDir: string): Set<string> {
  const names = new Set<string>();
  try {
    const entries = readdirSync(workspaceSkillsDir);
    for (const name of entries) {
      try {
        const stat = lstatSync(join(workspaceSkillsDir, name));
        if (stat.isDirectory()) names.add(name);
      } catch { /* skip */ }
    }
  } catch { /* dir missing or unreadable */ }
  return names;
}

/**
 * Mutates live symlinks and the skill manifest (installTeamSkills/
 * uninstallTeamSkill), so the whole tick must run under the profile-switch
 * lock — a switch's own uninstall/install can race this watcher's debounced
 * or fallback-poll tick otherwise. Wrapped as one lock-guarded unit (not one
 * attempt per install/uninstall call) so a tick either fully runs or fully
 * skips, never partially.
 */
async function handleWorkspaceSkillsChange(handlers: SkillWatchHandlers, options?: SkillWatchOptions): Promise<void> {
  const wsSkillsDir = getWorkspaceSkillsDir(options);
  if (!wsSkillsDir || !options?.activeProfile) return;

  await withProfileSwitchLock(() => {
    const currentNames = scanWorkspaceSkillNames(wsSkillsDir);

    // Detect newly added workspace skills
    const addedNames = [...currentNames].filter((n) => !knownWorkspaceSkillNames.has(n));
    // Detect removed workspace skills
    const removedNames = [...knownWorkspaceSkillNames].filter((n) => !currentNames.has(n));

    knownWorkspaceSkillNames = currentNames;

    if (addedNames.length > 0) {
      const inputs = addedNames.map((name) => ({
        name,
        sourcePath: join(wsSkillsDir, name),
      }));
      try {
        const result = installTeamSkills(inputs, options.activeProfile!, {
          claudeSkillsDir: options.claudeSkillsDir,
          codexSkillsDir: options.codexSkillsDir,
          manifestPath: options.manifestPath,
        });
        if (result.installed.length > 0) {
          handlers.onSkillsChanged(result.installed.length);
          handlers.onTeamSkillsChanged?.(result.installed.length);
        }
      } catch { /* non-fatal */ }
    }

    if (removedNames.length > 0 && options.activeProfile) {
      try {
        for (const name of removedNames) {
          uninstallTeamSkill(options.activeProfile, name, {
            claudeSkillsDir: options.claudeSkillsDir,
            codexSkillsDir: options.codexSkillsDir,
            manifestPath: options.manifestPath,
          });
        }
        handlers.onSkillsChanged(removedNames.length);
      } catch { /* non-fatal */ }
    }
  });
}

export function startSkillWatch(handlers: SkillWatchHandlers, options?: SkillWatchOptions): void {
  if (started) return;
  started = true;
  currentHandlers = handlers;
  currentOptions = options;

  knownSkillKeys.clear();
  knownHashes.clear();

  // Populate workspace-skill known state (read-only scan) before the
  // lock-guarded startup work below.
  const wsSkillsDir = getWorkspaceSkillsDir(options);
  if (wsSkillsDir && options?.activeProfile) {
    knownWorkspaceSkillNames = scanWorkspaceSkillNames(wsSkillsDir);
  }

  // Startup team-skill install + reconcile — one lock-guarded unit (mirrors
  // watchers/mcps.ts's startup): both mutate live symlinks and the manifest,
  // and a concurrent profile switch's own writes could otherwise race either
  // of them independently. Fire-and-forget async so it can be guarded by the
  // profile-switch lock without blocking watcher setup on it.
  withProfileSwitchLock(() => {
    if (wsSkillsDir && options?.activeProfile && knownWorkspaceSkillNames.size > 0) {
      const inputs = [...knownWorkspaceSkillNames].map((name) => ({
        name,
        sourcePath: join(wsSkillsDir, name),
      }));
      try {
        installTeamSkills(inputs, options.activeProfile, {
          claudeSkillsDir: options.claudeSkillsDir,
          codexSkillsDir: options.codexSkillsDir,
          manifestPath: options.manifestPath,
        });
      } catch { /* non-fatal */ }
    }
    return reconcileSkillManifest({
      claudeSkillsDir: options?.claudeSkillsDir,
      codexSkillsDir: options?.codexSkillsDir,
      manifestPath: options?.manifestPath,
    });
  })
    .then((reconcileResult) => {
      if (!reconcileResult) return;
      handlers.onReconciled(reconcileResult);
      if (reconcileResult.repaired.length > 0) {
        handlers.onSkillsChanged(reconcileResult.repaired.length);
      }
    })
    .catch(() => { /* reconcile failure must not prevent watcher from starting */ });

  // Populate initial known state
  const initialSkills = scanSkillDirectories({
    claudeSkillsDir: options?.claudeSkillsDir,
    codexSkillsDir: options?.codexSkillsDir,
  }).skills;
  for (const skill of initialSkills) {
    const key = skillKey(skill);
    knownSkillKeys.add(key);
    knownHashes.set(key, hashSkillDir(skill.dirPath));
  }

  const reconcile = () => {
    debounceTimer = null;

    const currentSkills = scanSkillDirectories({
      claudeSkillsDir: options?.claudeSkillsDir,
      codexSkillsDir: options?.codexSkillsDir,
    }).skills;

    const currentKeys = new Set(currentSkills.map(skillKey));
    const currentHashMap = new Map(currentSkills.map((s) => [skillKey(s), hashSkillDir(s.dirPath)]));

    // Detect removals: known keys no longer present
    const removedKeys = [...knownSkillKeys].filter((k) => !currentKeys.has(k));
    // Detect additions: new keys not previously seen
    const addedSkills = currentSkills.filter((s) => !knownSkillKeys.has(skillKey(s)));

    // Rename detection: match removed skill's hash against a new skill's hash
    // If a match is found, it's a rename — no user action needed (manifest is updated
    // by reconcileSkillManifest on the next startup).
    const renamedHashes = new Set<string>();
    for (const removedKey of removedKeys) {
      const removedHash = knownHashes.get(removedKey);
      if (!removedHash || removedHash === "sha256:empty") continue;
      const matchingAddition = addedSkills.find((s) => hashSkillDir(s.dirPath) === removedHash);
      if (matchingAddition) {
        renamedHashes.add(removedHash);
      }
    }

    // Filter additions that are not renames
    const genuineAdditions = addedSkills.filter((s) => !renamedHashes.has(hashSkillDir(s.dirPath)));

    // Update known state
    knownSkillKeys = currentKeys;
    knownHashes = currentHashMap;

    if (genuineAdditions.length === 0) return;

    // Detect pending vs conflicts for genuine additions
    try {
      const { pending, conflicts } = detectPending({
        claudeSkillsDir: options?.claudeSkillsDir,
        codexSkillsDir: options?.codexSkillsDir,
        manifestPath: options?.manifestPath,
      });

      if (pending.length > 0) handlers.onSkillsPending(pending);
      if (conflicts.length > 0) handlers.onSkillsConflict(conflicts);
    } catch { /* detection failure must not crash the watcher */ }
  };

  const skillDirs = [
    options?.claudeSkillsDir ?? `${homedir()}/.claude/skills`,
    options?.codexSkillsDir ?? `${homedir()}/.codex/skills`,
  ];

  for (const skillDir of skillDirs) {
    if (!existsSync(skillDir)) continue;
    try {
      watchers.push(watch(skillDir, { persistent: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(reconcile, DEBOUNCE_MS);
      }));
    } catch {
      // A missing permission must not prevent the other agent directory from watching.
    }
  }

  // Watch the workspace directory (parent of skills/) rather than skills/ directly.
  // draft load uses rmSync+cpSync which deletes and recreates skills/ with a new inode,
  // breaking any watcher placed on the old skills/ directory.
  if (wsSkillsDir) {
    const workspaceDir = dirname(wsSkillsDir);
    try {
      mkdirSync(workspaceDir, { recursive: true });
    } catch { /* non-fatal */ }
    if (existsSync(workspaceDir)) {
      try {
        watchers.push(watch(workspaceDir, { persistent: false }, (_event, filename) => {
          if (filename && filename !== "skills") return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void handleWorkspaceSkillsChange(handlers, options);
            reconcile();
          }, DEBOUNCE_MS);
        }));
      } catch { /* non-fatal */ }
    }
  }

  // Run an initial pending check after startup reconcile
  try {
    const { pending, conflicts } = detectPending({
      claudeSkillsDir: options?.claudeSkillsDir,
      codexSkillsDir: options?.codexSkillsDir,
      manifestPath: options?.manifestPath,
    });
    if (pending.length > 0) handlers.onSkillsPending(pending);
    if (conflicts.length > 0) handlers.onSkillsConflict(conflicts);
  } catch { /* non-fatal */ }

  // Fallback poll: fs.watch can miss events on networked or sandboxed paths
  fallbackTimer = setInterval(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (wsSkillsDir) void handleWorkspaceSkillsChange(handlers, options);
      reconcile();
    }, DEBOUNCE_MS);
  }, FALLBACK_POLL_MS);
}

export function stopSkillWatch(): void {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  knownSkillKeys.clear();
  knownHashes.clear();
  knownWorkspaceSkillNames.clear();
  currentHandlers = null;
  currentOptions = undefined;
  started = false;
}

/**
 * Restart the skill watcher with a new active profile.
 * Called from the switchProfile RPC handler after profile switch completes.
 */
export function restartSkillWatchWithProfile(newProfile: string): void {
  if (!currentHandlers) return;
  const handlers = currentHandlers;
  const options = { ...currentOptions, activeProfile: newProfile };
  stopSkillWatch();
  startSkillWatch(handlers, options);
}
