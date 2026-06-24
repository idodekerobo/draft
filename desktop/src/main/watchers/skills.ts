// desktop/src/main/watchers/skills.ts — cross-agent skill auto-import watcher

import { existsSync, watch } from "fs";
import { homedir } from "os";
import {
  createSymlinks,
  scanSkillDirectories,
  type ScannedSkill,
} from "draft-core/scanner";

const DEBOUNCE_MS = 300;
const FALLBACK_POLL_MS = 1_000;

export interface SkillWatchHandlers {
  onSkillsChanged: (count: number) => void;
}

export interface SkillWatchOptions {
  claudeSkillsDir?: string;
  codexSkillsDir?: string;
  manifestPath?: string;
}

let watchers: Array<ReturnType<typeof watch>> = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let knownSkills = new Set<string>();
let started = false;

function keyFor(skill: ScannedSkill): string {
  return `${skill.agent}:${skill.dirPath}`;
}

function currentSkills(options?: SkillWatchOptions): ScannedSkill[] {
  return scanSkillDirectories({
    claudeSkillsDir: options?.claudeSkillsDir,
    codexSkillsDir: options?.codexSkillsDir,
  }).skills;
}

export function startSkillWatch(handlers: SkillWatchHandlers, options?: SkillWatchOptions): void {
  if (started) return;
  started = true;

  knownSkills.clear();

  const skillDirs = [
    options?.claudeSkillsDir ?? `${homedir()}/.claude/skills`,
    options?.codexSkillsDir ?? `${homedir()}/.codex/skills`,
  ];

  const reconcile = () => {
    debounceTimer = null;
    const skills = currentSkills(options);
    const additions = skills.filter((skill) => !knownSkills.has(keyFor(skill)));
    if (additions.length === 0) {
      knownSkills = new Set(skills.map(keyFor));
      return;
    }

    const result = createSymlinks(additions, {
      claudeSkillsDir: options?.claudeSkillsDir,
      codexSkillsDir: options?.codexSkillsDir,
      manifestPath: options?.manifestPath,
    });
    const refreshedSkills = currentSkills(options);
    knownSkills = new Set(refreshedSkills.map(keyFor));

    if (result.created.length > 0) handlers.onSkillsChanged(result.created.length);
  };

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

  reconcile();

  // fs.watch can miss events on networked, sandboxed, or newly-created paths.
  // Reconcile at a low frequency so portability never depends on a single OS API.
  fallbackTimer = setInterval(reconcile, FALLBACK_POLL_MS);
}

export function stopSkillWatch(): void {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  knownSkills.clear();
  started = false;
}
