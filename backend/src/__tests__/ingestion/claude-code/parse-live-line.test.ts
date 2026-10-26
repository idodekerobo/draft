import { describe, expect, it } from "bun:test";
import { agentIdFromFile, parseLiveLine } from "../../../ingestion/claude-code/parse-live-line";

function parse(record: Record<string, unknown>, offset = 0, file = "root.jsonl") {
  return parseLiveLine({ file, offset, raw: JSON.stringify(record) });
}

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: "u-1",
  timestamp: "2026-10-26T20:00:00.000Z",
  message: { role: "user", content },
  ...extra,
});

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid: "a-1",
  message: { role: "assistant", content },
  ...extra,
});

describe("parseLiveLine: turns", () => {
  it("maps a typed user turn", () => {
    expect(parse(user("Run ls in this folder"))).toEqual([
      { sourceId: "u-1", kind: "user_message", payload: { timestamp: "2026-10-26T20:00:00.000Z", text: "Run ls in this folder" } },
    ]);
  });

  it("maps assistant text, thinking and tool_use blocks in order", () => {
    const events = parse(
      assistant([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Looking" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ]),
    );
    expect(events.map((e) => [e.sourceId, e.kind])).toEqual([
      ["a-1", "thinking"],
      ["a-1#1", "assistant_text"],
      ["a-1#2", "tool_use"],
    ]);
    expect(events[2]!.payload).toMatchObject({ tool_use_id: "t1", name: "Bash", input: { command: "ls" } });
  });

  it("maps a tool result with its tool id and error flag", () => {
    const [event] = parse(user([{ type: "tool_result", tool_use_id: "t1", content: "file.txt", is_error: true }]));
    expect(event).toMatchObject({ kind: "tool_result", payload: { tool_use_id: "t1", content: "file.txt", is_error: true } });
  });

  it("flattens a tool result made of blocks and marks images", () => {
    const [event] = parse(user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }, { type: "image" }] }]));
    expect(event!.payload.content).toBe("a\n[image]");
  });

  it("keeps typed text next to a tool result in the same line", () => {
    const events = parse(user([{ type: "text", text: "also this" }, { type: "tool_result", tool_use_id: "t1", content: "ok" }]));
    expect(events.map((e) => e.kind)).toEqual(["user_message", "tool_result"]);
  });
});

describe("parseLiveLine: notes and skips", () => {
  it("turns a compact boundary and local command output into notes", () => {
    expect(parse({ type: "system", subtype: "compact_boundary", uuid: "s1" })[0]).toMatchObject({ kind: "session_note", payload: { text: "Conversation compacted" } });
    const [note] = parse(user("<local-command-stdout>\u001b[2mCompacted (ctrl+o)\u001b[22m</local-command-stdout>"));
    expect(note).toMatchObject({ kind: "session_note", payload: { text: "Compacted (ctrl+o)" } });
  });

  it("skips other system lines and unrelated line types", () => {
    for (const type of ["attachment", "api-request", "ai-title", "permission-mode"]) {
      expect(parse({ type, uuid: "x", message: { role: "user", content: "text" } })).toEqual([]);
    }
    expect(parse({ type: "system", subtype: "turn_duration", uuid: "x" })).toEqual([]);
  });

  it("skips meta lines, compact summaries and bookkeeping text", () => {
    expect(parse(user("x", { isMeta: true }))).toEqual([]);
    expect(parse(user("This session is being continued", { isCompactSummary: true }))).toEqual([]);
    for (const text of ["<task-notification>\n<task-id>a1</task-id>\n</task-notification>", "<command-name>/compact</command-name>", "<system-reminder>note</system-reminder>"]) {
      expect(parse(user(text))).toEqual([]);
    }
  });

  it("keeps a typed slash command", () => {
    expect(parse(user("/compact"))[0]!.payload.text).toBe("/compact");
  });

  it("ignores a truncated line", () => {
    expect(parseLiveLine({ file: "root.jsonl", offset: 0, raw: '{"type":"us' })).toEqual([]);
  });
});

describe("parseLiveLine: source ids", () => {
  it("uses the native uuid, else file and offset", () => {
    expect(parse(user("hi"), 7)[0]!.sourceId).toBe("u-1");
    expect(parse(user("hi", { uuid: undefined }), 7)[0]!.sourceId).toBe("root.jsonl:7");
  });
});

describe("parseLiveLine: sub-agents", () => {
  it("reads the agent id from the file name", () => {
    expect(agentIdFromFile("subagents/agent-a754bec9.jsonl")).toBe("a754bec9");
    expect(agentIdFromFile("root.jsonl")).toBeNull();
  });

  it("drops side-chain lines from the root file but keeps them in a sub-agent file", () => {
    const line = assistant([{ type: "text", text: "listing" }], { isSidechain: true });
    expect(parse(line)).toEqual([]);
    const [event] = parse(line, 0, "subagents/agent-a1.jsonl");
    expect(event).toMatchObject({ kind: "assistant_text", payload: { text: "listing", agent_id: "a1" } });
  });
});

describe("parseLiveLine: size limits", () => {
  it("clips long tool output and flags it", () => {
    const [event] = parse(user([{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(50_000) }]));
    expect((event!.payload.content as string).length).toBe(20_000);
    expect(event!.payload.truncated).toBe(true);
  });

  it("clips a large tool input to a string and flags it", () => {
    const [event] = parse(assistant([{ type: "tool_use", id: "t1", name: "Write", input: { content: "y".repeat(50_000) } }]));
    expect(typeof event!.payload.input).toBe("string");
    expect(event!.payload.input_truncated).toBe(true);
  });

  it("clips very long text and flags it", () => {
    const [event] = parse(user("z".repeat(150_000)));
    expect((event!.payload.text as string).length).toBe(100_000);
    expect(event!.payload.truncated).toBe(true);
  });
});
