import { describe, expect, it } from "bun:test";
import { outputAfter, runSlashCommand, switchClaudeAgent, type AgentSwitchDeps } from "../../../../host/drivers/claude/agent-switch";

/** A pane that shows each screen in turn, one per capture, and records what was typed. */
function pane(screens: string[]) {
  const typed: string[] = [];
  let at = 0;
  const deps: AgentSwitchDeps = {
    capture: async () => screens[Math.min(at++, screens.length - 1)]!,
    paste: async (text) => void typed.push(`paste:${text}`),
    pressEnter: async () => void typed.push("enter"),
    sleep: async () => {},
  };
  return { deps, typed };
}

describe("outputAfter", () => {
  it("ignores an older result above the command that was just typed", () => {
    const screen = "❯ /model sonnet\n  ⎿  Set model to Sonnet 5.5\n❯ /model haiku\n  ⎿  working";
    expect(outputAfter(screen, "/model haiku")).not.toContain("Sonnet");
  });
});

describe("runSlashCommand", () => {
  it("succeeds on the line Claude prints", async () => {
    const { deps, typed } = pane(["❯ /effort high\n  ⎿  Set effort level to high (saved as your default for new sessions)"]);
    expect(await runSlashCommand("/effort high", deps)).toEqual({ ok: true });
    expect(typed).toEqual(["paste:/effort high", "enter"]);
  });

  it("answers the Switch model dialog once, and only when it is shown", async () => {
    const dialog = "❯ /model haiku\n   Switch model?\n   ❯ 1. Yes, switch to Haiku 5.5\n     2. No, go back";
    const { deps, typed } = pane([dialog, dialog, "❯ /model haiku\n  ⎿  Set model to Haiku 5.5 and saved as your default"]);
    expect(await runSlashCommand("/model haiku", deps)).toEqual({ ok: true });
    expect(typed.filter((key) => key === "enter")).toHaveLength(2);
  });

  it("does not press Enter when no dialog appears", async () => {
    const { deps, typed } = pane(["❯ /model haiku\n  ⎿  Set model to Haiku 5.5"]);
    await runSlashCommand("/model haiku", deps);
    expect(typed.filter((key) => key === "enter")).toHaveLength(1);
  });

  it("reports a refusal and a command that never confirms", async () => {
    expect((await runSlashCommand("/effort max", pane(["❯ /effort max\n  ⎿  Invalid argument: max"]).deps)).ok).toBe(false);
    const silent = await runSlashCommand("/model opus", pane(["❯ /model opus\n"]).deps);
    expect(silent.ok).toBe(false);
  });
});

describe("switchClaudeAgent", () => {
  it("changes the model before the effort, and skips what is not asked", async () => {
    const { deps, typed } = pane(["⎿  Set model to Opus 5.5", "⎿  Set effort level to high"]);
    expect(await switchClaudeAgent({ model: "opus", effort: "high" }, deps)).toEqual({ ok: true });
    expect(typed.filter((key) => key.startsWith("paste"))).toEqual(["paste:/model opus", "paste:/effort high"]);
    const effortOnly = pane(["⎿  Effort level set to auto"]);
    await switchClaudeAgent({ model: null, effort: "auto" }, effortOnly.deps);
    expect(effortOnly.typed.filter((key) => key.startsWith("paste"))).toEqual(["paste:/effort auto"]);
  });

  it("stops after a failed model change", async () => {
    const { deps, typed } = pane(["❯ /model nope\n  ⎿  Unknown model: nope"]);
    expect((await switchClaudeAgent({ model: "nope", effort: "high" }, deps)).ok).toBe(false);
    expect(typed.filter((key) => key.startsWith("paste"))).toEqual(["paste:/model nope"]);
  });
});
