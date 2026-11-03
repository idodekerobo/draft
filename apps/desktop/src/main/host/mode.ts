export type ClaudeMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

/** The footer Claude Code shows under the message box, for each mode. There is no command to set a mode, only Shift+Tab. */
const FOOTERS: Array<[RegExp, ClaudeMode]> = [
  [/manual mode on/, "default"],
  [/accept edits on/, "acceptEdits"],
  [/plan mode on/, "plan"],
  [/auto mode on/, "auto"],
  [/bypass permissions on/, "bypassPermissions"],
  [/don't ask on/, "dontAsk"],
];

/** Modes Shift+Tab can reach. The two launch-only modes are never a target. */
export const CYCLE_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits", "plan", "auto"]);

const MAX_PRESSES = 8;
const SETTLE_POLLS = 20;
const SETTLE_MS = 100;
const FOOTER_LINES = 8;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The mode in the footer of a Claude pane, or null when there is no footer, for example behind a dialog. */
export function modeFromScreen(screen: string): ClaudeMode | null {
  const lines = screen.replace(ANSI, "").split("\n").filter((line) => line.trim() !== "");
  const footer = lines.slice(-FOOTER_LINES).join("\n");
  for (const [pattern, mode] of FOOTERS) if (pattern.test(footer)) return mode;
  return null;
}

export interface ModeDeps {
  capture(): Promise<string>;
  pressBackTab(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type SwitchResult = { ok: true; mode: ClaudeMode } | { ok: false; reason: "unreadable" | "unreachable"; mode: ClaudeMode | null };

/** Presses Shift+Tab until the footer shows the target. The cycle is walked, because its length varies with the session. */
export async function switchMode(target: ClaudeMode, deps: ModeDeps): Promise<SwitchResult> {
  let current = modeFromScreen(await deps.capture());
  if (current === null) return { ok: false, reason: "unreadable", mode: null };
  for (let press = 0; press < MAX_PRESSES; press++) {
    if (current === target) return { ok: true, mode: current };
    await deps.pressBackTab();
    // The footer repaints after the key press, so wait for it to change before reading it.
    for (let poll = 0; poll < SETTLE_POLLS; poll++) {
      await deps.sleep(SETTLE_MS);
      const seen = modeFromScreen(await deps.capture());
      if (seen !== null && seen !== current) {
        current = seen;
        break;
      }
    }
  }
  return current === target ? { ok: true, mode: current } : { ok: false, reason: "unreachable", mode: current };
}
