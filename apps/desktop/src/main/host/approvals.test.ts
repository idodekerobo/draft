import { describe, expect, it } from "bun:test";
import { ApprovalBroker, questionsFromInput, summarizeToolInput, type HostEvent } from "./approvals";

function setup(options: { failPost?: boolean; pane?: boolean; expireMs?: number; oneAtATime?: boolean } = {}) {
  const events: HostEvent[] = [];
  const open = new Set<string>();
  const pane = { blocked: options.pane ?? false };
  let n = 0;
  const broker = new ApprovalBroker({
    postEvents: async (batch) => {
      if (options.failPost) throw new Error("offline");
      events.push(...batch);
    },
    paneBlocked: async () => pane.blocked,
    newId: () => `r${++n}`,
    onOpen: (id) => open.add(id),
    onClose: (id) => open.delete(id),
    expireMs: options.expireMs,
    oneAtATime: options.oneAtATime,
  });
  return { broker, events, open, pane };
}

const bash = { tool_name: "Bash", tool_input: { command: "ls" } };
const tick = () => new Promise((done) => setTimeout(done, 0));

describe("ApprovalBroker", () => {
  it("posts the request, holds it, and answers allow with the decider recorded", async () => {
    const { broker, events, open } = setup();
    const held = broker.hold(bash, new AbortController().signal);
    await tick();
    expect(events[0]).toMatchObject({ sourceId: "perm:r1", kind: "permission_request", payload: { requestId: "r1", name: "Bash", input: { command: "ls" } } });
    expect([...open]).toEqual(["r1"]);

    expect(broker.decide("r1", "allow", { userId: "u1", name: "Dev" })).toBe(true);
    expect(await held).toEqual({ behavior: "allow" });
    expect(events[1]).toMatchObject({ sourceId: "permres:r1", kind: "permission_resolved", payload: { reason: "decided", decision: "allow", by_name: "Dev" } });
    expect(open.size).toBe(0);
  });

  it("answers deny with a message that names the decider", async () => {
    const { broker } = setup();
    const held = broker.hold(bash, new AbortController().signal);
    await tick();
    broker.decide("r1", "deny", { userId: "u1", name: "Dev" });
    expect(await held).toEqual({ behavior: "deny", message: "Denied by Dev in Draft." });
  });

  it("the second decision for a request changes nothing", async () => {
    const { broker } = setup();
    const held = broker.hold(bash, new AbortController().signal);
    await tick();
    expect(broker.decide("r1", "allow", { userId: "u1", name: "Dev" })).toBe(true);
    expect(broker.decide("r1", "deny", { userId: "u2", name: "Priya" })).toBe(false);
    expect(await held).toEqual({ behavior: "allow" });
    expect(broker.decide("nope", "allow", { userId: "u1", name: "Dev" })).toBe(false);
  });

  it("an answer in the terminal ends the hook: resolved as answered_locally", async () => {
    const { broker, events } = setup({ pane: false });
    const controller = new AbortController();
    const held = broker.hold(bash, controller.signal);
    await tick();
    controller.abort();
    expect(await held).toBeNull();
    expect(events[1]!.payload).toMatchObject({ reason: "answered_locally" });
  });

  it("the dialog leaving the pane means the owner answered in the terminal", async () => {
    const { broker, events, open, pane: state } = setup({ pane: true });
    const held = broker.hold(bash, new AbortController().signal);
    await tick();
    await broker.watchPane();
    state.blocked = false;
    await broker.watchPane();
    expect(open.size).toBe(1);
    await broker.watchPane();
    expect(await held).toBeNull();
    expect(events[1]!.payload).toMatchObject({ reason: "answered_locally" });
    expect(open.size).toBe(0);
  });

  it("a request is not closed before its dialog was seen, or on one missed check", async () => {
    const { broker, open, pane: state } = setup();
    const held = broker.hold(bash, new AbortController().signal);
    await tick();
    for (let i = 0; i < 4; i++) await broker.watchPane();
    expect(open.size).toBe(1);
    state.blocked = true;
    await broker.watchPane();
    state.blocked = false;
    await broker.watchPane();
    state.blocked = true;
    await broker.watchPane();
    state.blocked = false;
    await broker.watchPane();
    expect(open.size).toBe(1);
    broker.decide("r1", "allow", { userId: "u", name: "Dev" });
    await held;
  });

  it("a new request closes the held one as answered in the terminal when Claude asks one at a time", async () => {
    const { broker, events, open, pane } = setup({ oneAtATime: true, pane: true });
    const plan = broker.hold({ tool_name: "ExitPlanMode", tool_input: { plan: "# p" } }, new AbortController().signal);
    await tick();
    const write = broker.hold({ tool_name: "Write", tool_input: { file_path: "/a" } }, new AbortController().signal);
    await tick();
    expect(await plan).toBeNull();
    expect(events.filter((e) => e.kind === "permission_resolved")).toEqual([
      expect.objectContaining({ sourceId: "permres:r1", payload: { requestId: "r1", reason: "answered_locally" } }),
    ]);
    expect([...open]).toEqual(["r2"]);
    broker.decide("r2", "allow", { userId: "u1", name: "Dev" });
    expect(await write).toEqual({ behavior: "allow" });
    expect(pane.blocked).toBe(true);
  });

  it("holds several requests at once when the harness can ask in parallel", async () => {
    const { broker, open } = setup();
    void broker.hold(bash, new AbortController().signal);
    void broker.hold(bash, new AbortController().signal);
    await tick();
    expect([...open].sort()).toEqual(["r1", "r2"]);
  });

  it("a hook that ends while the pane still asks is hook_gone", async () => {
    const { broker, events } = setup({ pane: true });
    const controller = new AbortController();
    const held = broker.hold(bash, controller.signal);
    await tick();
    controller.abort();
    await held;
    expect(events[1]!.payload).toMatchObject({ reason: "hook_gone" });
  });

  it("an unanswered request expires and leaves the dialog to Claude", async () => {
    const { broker, events } = setup({ expireMs: 5 });
    expect(await broker.hold(bash, new AbortController().signal)).toBeNull();
    expect(events[1]!.payload).toMatchObject({ reason: "expired" });
  });

  it("falls back to the dialog when the request cannot be posted", async () => {
    const { broker, open } = setup({ failPost: true });
    expect(await broker.hold(bash, new AbortController().signal)).toBeNull();
    expect(open.size).toBe(0);
  });

  it("leaves a hook call with no tool name to Claude's own dialog", async () => {
    const { broker, events } = setup();
    expect(await broker.hold({ tool_input: {} }, new AbortController().signal)).toBeNull();
    expect(events).toEqual([]);
  });

  it("closes a request an earlier run left open", async () => {
    const { broker, events, open } = setup();
    open.add("old");
    await broker.closeOnServer("old", { requestId: "old", reason: "hook_gone" });
    expect(events[0]).toMatchObject({ sourceId: "permres:old", kind: "permission_resolved" });
    expect(open.size).toBe(0);
  });
});

describe("summarizeToolInput", () => {
  it("keeps a small input and cuts a large one", () => {
    expect(summarizeToolInput({ a: 1 })).toEqual({ input: { a: 1 }, input_truncated: false });
    const big = summarizeToolInput({ text: "x".repeat(9000) });
    expect(big.input_truncated).toBe(true);
    expect((big.input as string).length).toBe(4000);
  });

  describe("questions", () => {
    const ask = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Pick colors", header: "Color", multiSelect: true, options: [{ label: "Red", description: "warm" }, { label: "Blue" }] },
          { question: "Pick a size", options: [{ label: "S" }, { label: "L" }] },
        ],
      },
    };

    it("posts the question as a request of kind question, with the questions in a plain shape", async () => {
      const { broker, events } = setup();
      void broker.hold(ask, new AbortController().signal);
      await tick();
      const payload = events[0]!.payload as { kind: string; questions: Array<{ key: string; multiSelect: boolean; options: unknown[] }> };
      expect(payload.kind).toBe("question");
      expect(payload.questions.map((q) => [q.key, q.multiSelect, q.options.length])).toEqual([["Pick colors", true, 2], ["Pick a size", false, 2]]);
    });

    it("answers allow with the answers merged into the original input", async () => {
      const { broker, events } = setup();
      const held = broker.hold(ask, new AbortController().signal);
      await tick();
      broker.decide("r1", "allow", { userId: "u1", name: "Dev" }, { answers: { "Pick colors": ["Red", "Blue"], "Pick a size": "Huge (typed)", "Not asked": "x" } });
      expect(await held).toEqual({
        behavior: "allow",
        updatedInput: { ...ask.tool_input, answers: { "Pick colors": ["Red", "Blue"], "Pick a size": "Huge (typed)" } },
      });
      expect(events[1]!.payload).toMatchObject({ reason: "decided", answers: { "Pick a size": "Huge (typed)" } });
    });

    it("allow without answers leaves Claude to ask in the pane", async () => {
      const { broker } = setup();
      const held = broker.hold(ask, new AbortController().signal);
      await tick();
      broker.decide("r1", "allow", { userId: "u1", name: "Dev" });
      expect(await held).toEqual({ behavior: "allow" });
    });

    it("drops malformed questions", () => {
      expect(questionsFromInput({ questions: [{ question: "", options: [] }, { question: "Q", options: [] }, { question: "Ok", options: ["A", { label: "" }] }] })).toEqual([
        { key: "Ok", question: "Ok", options: [{ label: "A" }], multiSelect: false, isOther: true, isSecret: false },
      ]);
      expect(questionsFromInput(null)).toEqual([]);
    });
  });

  describe("plans and reasons", () => {
    const plan = { tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n" + "x".repeat(9000), planFilePath: "/p.md" } };

    it("keeps the whole plan and answers allow with the original input, or Claude asks again in the pane", async () => {
      const { broker, events } = setup();
      const held = broker.hold(plan, new AbortController().signal);
      await tick();
      const payload = events[0]!.payload as { kind: string; plan: string };
      expect(payload.kind).toBe("plan");
      expect(payload.plan.length).toBe(plan.tool_input.plan.length);
      broker.decide("r1", "allow", { userId: "u1", name: "Dev" });
      expect(await held).toEqual({ behavior: "allow", updatedInput: plan.tool_input });
    });

    it("a deny reason reaches the message, with the decider named", async () => {
      const { broker, events } = setup();
      const held = broker.hold(plan, new AbortController().signal);
      await tick();
      broker.decide("r1", "deny", { userId: "u1", name: "Dev" }, { message: "  make it two steps  " });
      expect(await held).toEqual({ behavior: "deny", message: "Denied by Dev in Draft: make it two steps" });
      expect(events[1]!.payload).toMatchObject({ message: "make it two steps" });
    });

    it("a plain approval still carries kind approval and no extra fields", async () => {
      const { broker, events } = setup();
      void broker.hold(bash, new AbortController().signal);
      await tick();
      expect(events[0]!.payload).toMatchObject({ kind: "approval", name: "Bash" });
      expect(events[0]!.payload).not.toHaveProperty("questions");
    });
  });
});
