// core/src/sync/claude-settings.ts — shared, transactional .claude/settings.json
// read/write helper for the CLI and desktop app.

import { existsSync, readFileSync } from "fs";
import { atomicPatch, ParseError } from "./atomic-write";

export interface ClaudeSettings {
  hooks?: {
    SessionEnd?: Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type SettingsReadResult =
  | { ok: true; settings: ClaudeSettings }
  | { ok: false; reason: "malformed" };

export function readClaudeSettings(path: string): SettingsReadResult {
  if (!existsSync(path)) return { ok: true, settings: {} };
  try {
    return { ok: true, settings: JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export type SettingsMutateResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "malformed" };

// Malformed existing JSON is refused and the file is left byte-for-byte
// unchanged — never coerced to `{}`. `mutate` gets the parsed settings and
// returns the next value; unrelated keys pass through untouched since the
// caller only ever spreads and edits `hooks`.
export async function mutateClaudeSettingsAtomic(
  path: string,
  mutate: (settings: ClaudeSettings) => ClaudeSettings,
): Promise<SettingsMutateResult> {
  let malformed = false;
  let changed = false;
  try {
    await atomicPatch(
      path,
      (rawText) => {
        let settings: ClaudeSettings;
        if (rawText.trim() === "") {
          settings = {};
        } else {
          try {
            settings = JSON.parse(rawText) as ClaudeSettings;
          } catch (e) {
            malformed = true;
            throw new ParseError(path, e);
          }
        }
        const next = mutate(settings);
        // Reference equality is the pure mutators' no-op signal (both
        // mergeSessionEndHook and removeSessionEndHook return the same
        // settings object when there's nothing to do) -- skip writing
        // entirely rather than normalizing formatting into a file (and
        // parent directory) that may not even exist yet.
        if (next === settings) return rawText;
        changed = true;
        return `${JSON.stringify(next, null, 2)}\n`;
      },
      { mode: 0o644 },
    );
  } catch (e) {
    if (malformed) return { ok: false, reason: "malformed" };
    throw e;
  }
  return { ok: true, changed };
}

// A fresh temp file at the given mode replaces the target via rename, so
// this always lands at exactly `mode` regardless of the old file's
// permissions -- unlike writeFileSync's `mode` option, which only applies
// on create.
export async function writeCaptureConfigAtomic(path: string, config: object): Promise<void> {
  await atomicPatch(path, () => `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
