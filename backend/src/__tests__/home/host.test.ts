import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildHomeRunSpec } from "../../home/runtime/spec";
import { HomeHost } from "../../home/runtime/host";
import type { HostStore, PendingInput, RunPort, WakeBus } from "../../home/runtime/ports";
import type { HomeSessionRef } from "../../home/runtime/runs";
import { FakeEmbeddedAgent } from "../../embedded-agent/fake-adapter";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const CTX = "55555555-5555-4555-8555-555555555555";
const sid = (n: number) => `22222222-2222-4222-8222-22222222222${n}`;

class MemoryStore implements HostStore {
  claims = new Map<string, { owner: string; epoch: number; live: boolean }>();
  sessions = new Map<string, HomeSessionRef & { ended: boolean }>();
  inputs: Array<PendingInput & { sessionId: string }> = [];
  transitions: Array<{ id: string; to: string; reason: string | null }> = [];
  renewResult: boolean | Error = true;
  released: string[] = [];
  addSession(n: number) {
    const id = sid(n);
    this.sessions.set(id, { id, workspaceId: WS, ownerUserId: OWNER, model: "claude-test", ended: false });
    return id;
  }
  addInput(sessionId: string, kind: PendingInput["kind"], payload: Record<string, unknown>, id = `in-${this.inputs.length + 1}`) {
    this.inputs.push({ id, sessionId, kind, state: "queued", authorUserId: OWNER, authorName: "Owner", payload });
    return id;
  }
  async claim(sessionId: string, owner: string) {
    const held = this.claims.get(sessionId);
    if (held?.live && held.owner !== owner) return { claimed: false, epoch: held.epoch };
    const epoch = held ? (held.owner === owner && held.live ? held.epoch : held.epoch + 1) : 1;
    this.claims.set(sessionId, { owner, epoch, live: true });
    return { claimed: true, epoch };
  }
  async renew() {
    if (this.renewResult instanceof Error) throw this.renewResult;
    return this.renewResult;
  }
  async release(sessionId: string) {
    this.released.push(sessionId);
    const held = this.claims.get(sessionId);
    if (held) held.live = false;
  }
  async stillOwner(sessionId: string, owner: string, epoch: number) {
    const held = this.claims.get(sessionId);
    return !!held && held.live && held.owner === owner && held.epoch === epoch;
  }
  async loadSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }
  async pendingInputs(sessionId: string) {
    return this.inputs.filter((i) => i.sessionId === sessionId && (i.state === "queued" || i.state === "delivering"));
  }
  async transition(inputId: string, _sessionId: string, from: string[], to: string, reason: string | null) {
    const input = this.inputs.find((i) => i.id === inputId);
    if (!input || !from.includes(input.state)) return false;
    input.state = to as never;
    this.transitions.push({ id: inputId, to, reason });
    return true;
  }
  async setSessionModel(sessionId: string, model: string) {
    this.sessions.get(sessionId)!.model = model;
  }
  async sessionsNeedingRecovery() {
    return [...new Set(this.inputs.filter((i) => i.state === "queued" || i.state === "delivering").map((i) => i.sessionId))];
  }
}

class MemoryBus implements WakeBus {
  notified: string[] = [];
  handler: ((id: string) => void) | undefined;
  async notify(id: string) {
    this.notified.push(id);
  }
  listen(handler: (id: string) => void) {
    this.handler = handler;
    return () => (this.handler = undefined);
  }
}

function setup(overrides: { renewMs?: number; maxActive?: number; idleMs?: number } = {}) {
  const store = new MemoryStore();
  const bus = new MemoryBus();
  const agents = new Map<string, FakeEmbeddedAgent>();
  const projected: string[] = [];
  const seenSettled = new Map<string, number>();
  const runCalls: string[] = [];
  const runs: RunPort = {
    open: async (session) => {
      runCalls.push(`open:${session.id}`);
      const spec = buildHomeRunSpec({ runId: "66666666-6666-4666-8666-666666666666", workspaceId: WS, ownerUserId: OWNER, sessionId: session.id, model: null, contextVersionId: CTX, instructions: "" });
      return { id: spec.id, spec };
    },
    settle: async (sessionId) => {
      runCalls.push(`settle:${sessionId}`);
      return true;
    },
  };
  const host = new HomeHost({
    store,
    bus,
    runs,
    owner: "proc-a",
    instructions: () => "be helpful",
    factory: (context) => {
      const agent = new FakeEmbeddedAgent();
      agents.set(context.sessionId, agent);
      return agent;
    },
    // Reads what the fake agent committed, like the projector reads the outbox.
    project: async (session) => {
      projected.push(session.id);
      const log = agents.get(session.id)!.committed();
      const from = seenSettled.get(session.id) ?? 0;
      seenSettled.set(session.id, log.length);
      return log.slice(from).flatMap((event) => (event.body.kind === "turn_settled" ? [{ requestId: event.body.requestId, outcome: event.body.outcome }] : []));
    },
    renewMs: overrides.renewMs ?? 60_000,
    maxActive: overrides.maxActive,
    idleMs: overrides.idleMs,
  });
  return { store, bus, agents, host, projected, runCalls };
}

let host: HomeHost | undefined;
beforeEach(() => {
  host = undefined;
});
afterEach(async () => {
  await host?.stop();
});

describe("the Home host", () => {
  it("submits a saved message to the agent it owns, once, and marks the input delivering", async () => {
    const t = setup();
    host = t.host;
    const id = t.store.addSession(1);
    const input = t.store.addInput(id, "message", { text: "hello" });
    expect(await t.host.deliver(id)).toBe(true);
    expect(await t.host.deliver(id)).toBe(true);
    const agent = t.agents.get(id)!;
    const events: string[] = [];
    for await (const event of agent.events(0)) {
      events.push(event.body.kind);
      if (event.body.kind === "turn_settled") break;
    }
    expect(events).toEqual(["user_message", "assistant_text", "turn_settled"]);
    expect(t.store.transitions).toEqual([{ id: input, to: "delivering", reason: null }]);
    expect(t.runCalls[0]).toBe(`open:${id}`);
  });

  it("answers a waiting question from a saved decision, and fails a decision for a question that is not waiting", async () => {
    const t = setup();
    host = t.host;
    const id = t.store.addSession(1);
    const first = t.store.addInput(id, "message", { text: "ask: Go?" });
    await t.host.deliver(id);
    const agent = t.agents.get(id)!;
    const reqId = `call-${first}`;
    const yes = t.store.addInput(id, "permission_decision", { requestId: reqId, decision: "allow" });
    const stale = t.store.addInput(id, "permission_decision", { requestId: "call-nothing", decision: "allow" });
    await t.host.deliver(id);
    expect(t.store.transitions.filter((x) => x.id === yes).map((x) => x.to)).toEqual(["delivering", "consumed"]);
    expect(t.store.transitions.filter((x) => x.id === stale).map((x) => [x.to, x.reason])).toEqual([["delivering", null], ["failed", "request_closed"]]);
    expect(agent).toBeDefined();
  });

  it("stops a running turn and changes the model from saved inputs", async () => {
    const t = setup();
    host = t.host;
    const id = t.store.addSession(1);
    t.store.addInput(id, "message", { text: "hold: work" });
    await t.host.deliver(id);
    const stop = t.store.addInput(id, "stop", {});
    const mode = t.store.addInput(id, "set_mode", { model: "claude-next" });
    await t.host.deliver(id);
    expect(t.store.transitions.filter((x) => x.id === stop).map((x) => x.to)).toEqual(["delivering", "consumed"]);
    expect(t.store.transitions.filter((x) => x.id === mode).map((x) => x.to)).toEqual(["delivering", "consumed"]);
    expect(t.store.sessions.get(id)!.model).toBe("claude-next");
  });

  it("leaves a Home that another process owns alone, and wakes that process", async () => {
    const t = setup();
    host = t.host;
    const id = t.store.addSession(1);
    t.store.claims.set(id, { owner: "proc-b", epoch: 4, live: true });
    t.store.addInput(id, "message", { text: "hello" });
    expect(await t.host.deliver(id)).toBe(false);
    expect(t.agents.size).toBe(0);
    await t.host.wake(id);
    expect(t.bus.notified).toEqual([id]);
  });

  it("delivers when the bus says its Home has work", async () => {
    const t = setup();
    host = t.host;
    t.host.start();
    const id = t.store.addSession(1);
    await t.host.deliver(id);
    t.store.addInput(id, "message", { text: "hello" });
    t.bus.handler!(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.store.transitions.map((x) => x.to)).toContain("delivering");
  });

  it("stops and closes the agent when the claim is lost", async () => {
    const t = setup({ renewMs: 10 });
    host = t.host;
    const id = t.store.addSession(1);
    await t.host.deliver(id);
    expect(t.host.home(id)).toMatchObject({ alive: true });
    t.store.renewResult = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.host.home(id)).toBeNull();
    await expect(t.agents.get(id)!.submit({ text: "x", authorUserId: OWNER }, "late")).rejects.toThrow();
  });

  it("keeps the agent through a failed renewal call while the claim still has time", async () => {
    const t = setup({ renewMs: 10 });
    host = t.host;
    const id = t.store.addSession(1);
    await t.host.deliver(id);
    t.store.renewResult = new Error("network");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.host.home(id)).toMatchObject({ alive: true });
  });

  it("reopens a Home with waiting work and no owner on its next sweep", async () => {
    const t = setup();
    host = t.host;
    const id = t.store.addSession(1);
    t.store.addInput(id, "message", { text: "hello" });
    await t.host.sweep();
    expect(t.host.openSessionIds()).toEqual([id]);
    expect(t.store.transitions.map((x) => x.to)).toContain("delivering");
  });

  it("ends the run once the turn has settled", async () => {
    const t = setup();
    host = t.host;
    const id = t.store.addSession(1);
    t.store.addInput(id, "message", { text: "hello" });
    await t.host.deliver(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.runCalls).toContain(`settle:${id}`);
  });

  it("closes an idle Home to make room, never one with work, and releases its claim", async () => {
    const t = setup({ maxActive: 1 });
    host = t.host;
    const a = t.store.addSession(1);
    const b = t.store.addSession(2);
    await t.host.deliver(a);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await t.host.deliver(b)).toBe(true);
    expect(t.host.openSessionIds()).toEqual([b]);
    expect(t.store.released).toContain(a);
  });

  it("does not open a Home past its limit when none can be closed", async () => {
    const t = setup({ maxActive: 1 });
    host = t.host;
    const a = t.store.addSession(1);
    const b = t.store.addSession(2);
    t.store.addInput(a, "message", { text: "hold: busy" });
    await t.host.deliver(a);
    expect(await t.host.deliver(b)).toBe(false);
  });
});
