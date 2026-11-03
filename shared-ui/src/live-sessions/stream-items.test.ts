import { describe, expect, it } from "bun:test";
import { approvalOutcome, buildStreamItems, isMine, openApprovals, toolSummary, type OpenApproval } from "./stream-items";
import type { LiveSessionEvent, LiveSessionEventKind, LiveSessionEventPayload } from "./types";

let seq = 0;
const event = (kind: LiveSessionEventKind, payload: LiveSessionEventPayload): LiveSessionEvent => ({
  seq: ++seq,
  source_id: `s${seq}`,
  kind,
  payload,
  created_at: "2026-10-26T20:00:00.000Z",
});

describe("buildStreamItems", () => {
  it("pairs a tool result with its tool call by id", () => {
    const items = buildStreamItems([
      event("tool_use", { tool_use_id: "t1", name: "Bash", input: { command: "ls -la" } }),
      event("assistant_text", { text: "Looking" }),
      event("tool_result", { tool_use_id: "t1", content: "a.txt", is_error: false }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["tool", "assistant"]);
    expect(items[0]).toMatchObject({ name: "Bash", summary: "ls -la", result: { text: "a.txt", isError: false, truncated: false } });
  });

  it("leaves the result empty until it arrives, and ignores a result with no call", () => {
    const items = buildStreamItems([
      event("tool_use", { tool_use_id: "t1", name: "Read", input: { file_path: "/a/b.ts" } }),
      event("tool_result", { tool_use_id: "nope", content: "x" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "tool", result: null });
  });

  it("keeps the order of turns, thinking and notes", () => {
    const items = buildStreamItems([
      event("user_message", { text: "hi" }),
      event("thinking", { text: "hmm" }),
      event("assistant_text", { text: "hello" }),
      event("session_note", { text: "Conversation compacted" }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["user", "thinking", "assistant", "note"]);
  });

  it("carries the sub-agent id", () => {
    const [item] = buildStreamItems([event("assistant_text", { text: "listing", agent_id: "a1" })]);
    expect(item).toMatchObject({ type: "assistant", agentId: "a1" });
  });

  it("marks failed and clipped results", () => {
    const [tool] = buildStreamItems([
      event("tool_use", { tool_use_id: "t1", name: "Bash", input: {} }),
      event("tool_result", { tool_use_id: "t1", content: "boom", is_error: true, truncated: true }),
    ]);
    expect(tool).toMatchObject({ result: { isError: true, truncated: true } });
  });
});

describe("toolSummary", () => {
  it("prefers the field that says what the tool acts on", () => {
    expect(toolSummary({ command: "bun test", description: "Run tests" })).toBe("bun test");
    expect(toolSummary({ file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
    expect(toolSummary({ pattern: "TODO" })).toBe("TODO");
  });

  it("falls back to the first string, and handles clipped or empty input", () => {
    expect(toolSummary({ thing: "value" })).toBe("value");
    expect(toolSummary("raw text\nsecond")).toBe("raw text");
    expect(toolSummary({})).toBe("");
    expect(toolSummary(undefined)).toBe("");
  });

  it("keeps the first line and clips it", () => {
    expect(toolSummary({ command: "echo one\necho two" })).toBe("echo one");
    expect(toolSummary({ command: "x".repeat(300) })).toHaveLength(101);
  });
});

describe("messages sent through Draft", () => {
  it("shows the author and removes the prefix from the text", () => {
    const items = buildStreamItems([
      { seq: 1, source_id: "a", kind: "user_message", payload: { text: "[Priya via Draft] please add tests\nthanks" }, created_at: "" },
      { seq: 2, source_id: "b", kind: "user_message", payload: { text: "[not a prefix] hi" }, created_at: "" },
    ]);
    expect(items[0]).toMatchObject({ type: "user", author: "Priya", text: "please add tests\nthanks" });
    expect(items[1]).toMatchObject({ type: "user", author: null, text: "[not a prefix] hi" });
  });
});

describe("approvals", () => {
  const request = (id: string) => event("permission_request", { requestId: id, name: "Write", input: { file_path: "/a/hello.txt" } });

  it("a request is open until a result with its id arrives", () => {
    const items = buildStreamItems([request("r1"), request("r2"), event("permission_resolved", { requestId: "r1", reason: "decided", decision: "allow", by_name: "Dev" })]);
    expect(items.map((i) => i.type)).toEqual(["approval", "approval"]);
    expect(openApprovals(items).map((a) => a.requestId)).toEqual(["r2"]);
    expect(items[0]).toMatchObject({ tool: "Write", summary: "/a/hello.txt", resolved: { reason: "decided", decision: "allow", byName: "Dev" } });
  });

  it("a request without a kind is a plain approval, and a question or plan keeps its fields", () => {
    const [old, ask, plan] = buildStreamItems([
      request("r1"),
      event("permission_request", {
        requestId: "r2",
        kind: "question",
        name: "AskUserQuestion",
        questions: [{ key: "Pick", question: "Pick", options: [{ label: "A" }], multiSelect: false, isOther: true, isSecret: false }],
      }),
      event("permission_request", { requestId: "r3", kind: "plan", name: "ExitPlanMode", plan: "# Plan" }),
    ]);
    expect(old).toMatchObject({ kind: "approval", questions: [], plan: null });
    expect(ask).toMatchObject({ kind: "question", questions: [{ key: "Pick" }] });
    expect(plan).toMatchObject({ kind: "plan", plan: "# Plan" });
  });

  it("keeps what the decider answered or wrote on the resolved request", () => {
    const [item] = buildStreamItems([
      event("permission_request", { requestId: "r1", kind: "question", name: "AskUserQuestion" }),
      event("permission_resolved", { requestId: "r1", reason: "decided", decision: "allow", by_name: "Dev", answers: { Pick: ["A", "B"] }, message: "why" }),
    ]);
    expect(item).toMatchObject({ resolved: { answers: { Pick: ["A", "B"] }, message: "why" } });
    const [plain] = buildStreamItems([request("r2"), event("permission_resolved", { requestId: "r2", reason: "expired" })]);
    expect(plain).toMatchObject({ resolved: { answers: null, message: null } });
  });

  it("ignores a result for an unknown request", () => {
    expect(buildStreamItems([event("permission_resolved", { requestId: "zzz", reason: "expired" })])).toEqual([]);
  });

  it("words each way a request can end", () => {
    const outcome = (payload: LiveSessionEventPayload, host: string | null = "Maya's MacBook") => {
      const [item] = buildStreamItems([request("r"), event("permission_resolved", { requestId: "r", ...payload })]);
      return approvalOutcome(item as never, host).replace(/, \d{1,2}:\d{2}.*$/, "");
    };
    expect(outcome({ reason: "decided", decision: "allow", by_name: "Dev" })).toBe("Allowed by Dev");
    expect(outcome({ reason: "decided", decision: "deny", by_name: "Priya" })).toBe("Denied by Priya");
    const [asked] = buildStreamItems([event("permission_request", { requestId: "q", kind: "question", name: "AskUserQuestion", questions: [{ key: "Pick", question: "Pick one?", options: [], multiSelect: false, isOther: true, isSecret: false }] }), event("permission_resolved", { requestId: "q", reason: "decided", decision: "allow", by_name: "Dev" })]);
    expect(approvalOutcome(asked as never, null).replace(/, \d{1,2}:\d{2}.*$/, "")).toBe("Answered by Dev");
    expect(asked).toMatchObject({ summary: "Pick one?" });
    expect(outcome({ reason: "answered_locally" })).toBe("Answered on Maya's MacBook");
    expect(outcome({ reason: "answered_locally" }, null)).toBe("Answered in the terminal");
    expect(outcome({ reason: "expired" })).toBe("Expired");
    expect(outcome({ reason: "hook_gone" })).toBe("Moved to the terminal");
  });
});

describe("isMine", () => {
  const viewer = { id: "u1", name: "Maya", isOwner: true };
  const turn = (over: { author?: string | null; authorUserId?: string | null }) =>
    buildStreamItems([{ ...event("user_message", { text: over.author ? `[${over.author} via Draft] hi` : "hi" }), author_user_id: over.authorUserId ?? null }])[0] as Extract<ReturnType<typeof buildStreamItems>[number], { type: "user" }>;

  it("trusts the author's user id over the name", () => {
    expect(isMine(turn({ author: "Maya", authorUserId: "u2" }), viewer)).toBe(false);
    expect(isMine(turn({ author: "Someone", authorUserId: "u1" }), viewer)).toBe(true);
  });

  it("falls back to the name when no id is known", () => {
    expect(isMine(turn({ author: "Maya" }), viewer)).toBe(true);
    expect(isMine(turn({ author: "Priya" }), viewer)).toBe(false);
  });

  it("treats a turn typed in the terminal as the owner's", () => {
    expect(isMine(turn({}), viewer)).toBe(true);
    expect(isMine(turn({}), { ...viewer, isOwner: false })).toBe(false);
  });

  it("uses the input's own flag for a message still waiting", () => {
    const pending = (mine: boolean) => ({ type: "pending" as const, key: "k", author: "x", ownerName: "o", hostOffline: false, input: { mine } as never });
    expect(isMine(pending(true), viewer)).toBe(true);
    expect(isMine(pending(false), viewer)).toBe(false);
  });

  it("words a plan's outcome by what was chosen", () => {
    const at = "2026-10-27T10:00:00Z";
    const events = (resolved: Record<string, unknown>): LiveSessionEvent[] => [
      { seq: 1, source_id: "a", kind: "permission_request", payload: { requestId: "p1", kind: "plan", name: "ExitPlanMode", plan: "# P", permissionMode: "plan" }, created_at: at },
      { seq: 2, source_id: "b", kind: "permission_resolved", payload: { requestId: "p1", reason: "decided", by_name: "Dev", ...resolved }, created_at: at },
    ];
    const outcome = (resolved: Record<string, unknown>) => {
      const item = buildStreamItems(events(resolved)).find((i) => i.type === "approval") as OpenApproval;
      return approvalOutcome(item, null);
    };
    expect(outcome({ decision: "allow", permissionMode: "auto" })).toMatch(/^Approved by Dev, auto mode, /);
    expect(outcome({ decision: "allow", permissionMode: "default" })).toMatch(/^Approved by Dev, manual edits, /);
    expect(outcome({ decision: "deny", message: "2 steps" })).toMatch(/^Dev asked for changes, /);
  });
});
