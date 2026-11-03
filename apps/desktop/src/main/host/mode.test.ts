import { describe, expect, it } from "bun:test";
import { modeFromScreen, switchMode, type ModeDeps } from "./mode";

const RULE = "─".repeat(100);
const screen = (footer: string) => `✻ Done\n${RULE}\n❯ \n${RULE}\n  ${footer}\n`;
const FOOTERS = {
  default: "⏸ manual mode on · ? for shortcuts · ← 1 agent",
  acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent",
  plan: "⏸ plan mode on (shift+tab to cycle) · ← 1 agent",
  auto: "⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
} as const;
const ORDER = ["auto", "default", "acceptEdits", "plan"] as const;

describe("modeFromScreen", () => {
  it("reads each mode's footer, with colour codes in the way", () => {
    for (const [mode, footer] of Object.entries(FOOTERS)) expect(modeFromScreen(screen(footer))).toBe(mode as keyof typeof FOOTERS);
    expect(modeFromScreen(screen("\u001b[93m⏵⏵ auto mode on\u001b[2m (shift+tab to cycle)\u001b[0m"))).toBe("auto");
    expect(modeFromScreen(screen("⏵⏵ bypass permissions on (shift+tab to cycle)"))).toBe("bypassPermissions");
  });

  it("is null when there is no footer, as behind a dialog", () => {
    expect(modeFromScreen(" Do you want to create a.txt?\n ❯ 1. Yes\n   3. No\n Esc to cancel · Tab to amend\n")).toBeNull();
    expect(modeFromScreen("")).toBeNull();
  });

  it("ignores a mode named in older output above the footer", () => {
    expect(modeFromScreen(`I switched to plan mode on request.\n${"x\n".repeat(12)}${screen(FOOTERS.auto)}`)).toBe("auto");
  });
});

function pane(start: (typeof ORDER)[number], options: { stuck?: boolean } = {}) {
  let index = ORDER.indexOf(start);
  const presses: number[] = [];
  const deps: ModeDeps = {
    capture: async () => screen(FOOTERS[ORDER[index]!]),
    pressBackTab: async () => void (presses.push(index), options.stuck || (index = (index + 1) % ORDER.length)),
    sleep: async () => {},
  };
  return { deps, presses };
}

describe("switchMode", () => {
  it("does nothing when the session is already there", async () => {
    const { deps, presses } = pane("plan");
    expect(await switchMode("plan", deps)).toEqual({ ok: true, mode: "plan" });
    expect(presses).toEqual([]);
  });

  it("walks the cycle to the target, whichever mode it starts in", async () => {
    for (const from of ORDER) {
      for (const to of ORDER) {
        const { deps, presses } = pane(from);
        expect(await switchMode(to, deps)).toEqual({ ok: true, mode: to });
        expect(presses.length).toBe((ORDER.indexOf(to) - ORDER.indexOf(from) + ORDER.length) % ORDER.length);
      }
    }
  });

  it("says so when the footer cannot be read, or the key changes nothing", async () => {
    expect(await switchMode("plan", { capture: async () => "Do you want to proceed?", pressBackTab: async () => {}, sleep: async () => {} })).toEqual({ ok: false, reason: "unreadable", mode: null });
    const { deps } = pane("auto", { stuck: true });
    expect(await switchMode("plan", deps)).toEqual({ ok: false, reason: "unreachable", mode: "auto" });
  });
});
