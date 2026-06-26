// desktop/src/main/watchers/skills.ts — cross-agent skill watcher with approval gate

import { existsSync, watch } from "fs";
import { homedir } from "os";
import {
  detectPending,
  reconcileSkillManifest,
  hashSkillDir,
  scanSkillDirectories,
  type PendingSkillEntry,
  type SameNameConflict,
  type ReconcileResult,
  type ScannedSkill,
} from "draft-core/scanner";

// 2-second debounce to allow rename detection (disappear + reappear within the window)
const DEBOUNCE_MS = 2_000;
const FALLBACK_POLL_MS = 120_000;

export interface SkillWatchHandlers {
  onSkillsPending: (skills: PendingSkillEntry[]) => void;
  onSkillsConflict: (conflicts: SameNameConflict[]) => void;
  /** Fired when symlinks are created after approval (for UI badge count). */
  onSkillsChanged: (count: number) => void;
  onReconciled: (result: ReconcileResult) => void;
}

export interface SkillWatchOptions {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  manifestPath?: string;
}

let watchers: Array<ReturnType<typeof watch>> = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

// Track known skills by compound key + their directory hash (for rename detection)
let knownSkillKeys = new Set<string>();
let knownHashes = new Map<string, string>(); // "agent:dirPath" → skill_dir_hash

function skillKey(skill: ScannedSkill): string {
  return `${skill.agent}:${skill.dirPath}`;
}

export function startSkillWatch(handlers: SkillWatchHandlers, options?: SkillWatchOptions): void {
  if (started) return;
  started = true;

  knownSkillKeys.clear();
  knownHashes.clear();

  // Run startup reconcile before setting up watchers
  try {
    const reconcileResult = reconcileSkillManifest({
      claudeSkillsDir: options?.claudeSkillsDir,
      codexSkillsDir: options?.codexSkillsDir,
      manifestPath: options?.manifestPath,
    });
    handlers.onReconciled(reconcileResult);
    if (reconcileResult.repaired.length > 0) {
      handlers.onSkillsChanged(reconcileResult.repaired.length);
    }
  } catch { /* reconcile failure must not prevent watcher from starting */ }

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
    debounceTimer = setTimeout(reconcile, DEBOUNCE_MS);
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
  started = false;
}
