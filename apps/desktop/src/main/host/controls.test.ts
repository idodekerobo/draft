import { describe, expect, it } from "bun:test";
import { ControlActions, type ControlInput, type ControlDeps } from "./controls";

const RULE = "─".repeat(100);
const READY = `${RULE}\n❯ \n${RULE}\n  ⏸ manual mode on\n`;
const RUNNING = `✻ Working… (3s · esc to interrupt)\n${RULE}\n❯ \n${RULE}\n`;
const PERMISSION = " Do you want to create a.txt?\n ❯ 1. Yes\n   3. No\n Esc to cancel · Tab to amend\n";

const stop = (id: string, state: "queued" | "delivering" = "queued"): ControlInput => ({ id, kind: "stop", state, author_user_id: "u1", author_name: "Dev", payload: {} });
const decision = (id: string, requestId: string, value = "allow"): ControlInput => ({ id, kind: "permission_decision", state: "queued", author_user_id: "u1", author_name: "Dev", payload: { requestId, decision: value } });

function setup(pending: ControlInput[], screen = RUNNING, held = new Set<string>(), posted: unknown[] = []) {
  const log: string[] = [];
  const states = new Map(pending.map((p) => [p.id, p.state as string]));
  const deps: ControlDeps = {
    setState: async (id, from, to, reason) => {
      if (!from.includes(states.get(id) as never)) return false;
      states.set(id, to);
      log.push(`${id}:${to}${reason ? `(${reason})` : ""}`);
      return true;
    },
    decide: (requestId, value, by) => {
      if (!held.has(requestId)) return false;
      log.push(`decide:${requestId}:${value}:${by.name}`);
      return true;
    },
    capture: async () => screen,
    sendEscape: async () => void log.push("escape"),
    postEvents: async (events) => void (posted.push(events[0]), log.push(`note:${(events[0]!.payload as { text: string }).text}`)),
  };
  const actions = new ControlActions(deps);
  const current = () => pending.filter((p) => ["queued", "delivering"].includes(states.get(p.id)!)).map((p) => ({ ...p, state: states.get(p.id) as "queued" | "delivering" }));
  return { actions: { tick: () => actions.tick(current()) }, log };
}

describe("ControlActions", () => {
  it("Stop sends Esc to a running turn and leaves a note naming who stopped it", async () => {
    const { actions, log } = setup([stop("s1")]);
    await actions.tick();
    expect(log).toEqual(["s1:delivering", "escape", "note:Stopped by Dev", "s1:consumed"]);
  });

  it("Stop names who interrupted in the note", async () => {
    const events: unknown[] = [];
    const { actions } = setup([stop("s1")], RUNNING, new Set(), events);
    await actions.tick();
    expect(events[0]).toMatchObject({ payload: { interrupted_by: { id: "u1", name: "Dev" } } });
  });

  it("Stop at an idle prompt sends nothing and says so", async () => {
    const { actions, log } = setup([stop("s1")], READY);
    await actions.tick();
    expect(log).toEqual(["s1:delivering", "note:Dev pressed Stop, but nothing was running", "s1:consumed"]);
  });

  it("Stop cancels an open permission dialog", async () => {
    const { actions, log } = setup([stop("s1")], PERMISSION);
    await actions.tick();
    expect(log).toContain("escape");
  });

  it("applies a decision to the held request", async () => {
    const { actions, log } = setup([decision("d1", "r1", "deny")], READY, new Set(["r1"]));
    await actions.tick();
    expect(log).toEqual(["d1:delivering", "decide:r1:deny:Dev", "d1:consumed"]);
  });

  it("fails a decision whose request is no longer held", async () => {
    const { actions, log } = setup([decision("d1", "gone")]);
    await actions.tick();
    expect(log).toEqual(["d1:delivering", "d1:failed(request_not_open)"]);
  });

  it("fails an input an earlier run left delivering, once", async () => {
    const { actions, log } = setup([stop("old", "delivering")]);
    await actions.tick();
    await actions.tick();
    expect(log).toEqual(["old:failed(host_restarted)"]);
  });

  it("does nothing when another tick is running", async () => {
    const { actions, log } = setup([stop("s1")]);
    await Promise.all([actions.tick(), actions.tick()]);
    expect(log.filter((l) => l === "escape").length).toBe(1);
  });
});
