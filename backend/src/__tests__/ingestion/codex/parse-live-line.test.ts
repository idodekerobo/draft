import { describe, expect, it } from "bun:test";
import { codexEventsFor, parseCodexLine } from "../../../ingestion/codex/parse-live-line";
import { eventsForHarness } from "../../../ingestion/harness-lines";
import turn from "./turn-with-command.json";

const lines = turn.map((note, offset) => ({ file: "thread", offset, raw: JSON.stringify(note) }));

describe("parseCodexLine", () => {
  const events = lines.flatMap(parseCodexLine);

  it("maps a recorded turn to messages, a tool call with its result, and nothing for the turn end", () => {
    expect(events.map((e) => e.kind)).toEqual(["user_message", "assistant_text", "tool_use", "tool_result", "assistant_text"]);
    expect(events[0]!.payload.text).toContain("touch spike-file.txt");
    expect(events.at(-1)!.payload.text).toBe("done");
  });

  it("pairs a command's call and result by item id and flags a failure only on a bad exit", () => {
    const [use, result] = events.filter((e) => e.kind === "tool_use" || e.kind === "tool_result");
    expect(use!.payload).toMatchObject({ name: "command", input: { command: "/bin/zsh -lc 'touch spike-file.txt'" } });
    expect(result!.payload).toMatchObject({ tool_use_id: use!.payload.tool_use_id, is_error: false });
    expect(result!.sourceId).toBe(`${use!.sourceId}#1`);
  });

  it("gives every event a source id that is stable across parses", () => {
    expect(new Set(events.map((e) => e.sourceId)).size).toBe(events.length);
    expect(lines.flatMap(parseCodexLine).map((e) => e.sourceId)).toEqual(events.map((e) => e.sourceId));
  });

  it("notes a failed or interrupted turn and ignores other notifications", () => {
    const end = (status: string, error: unknown = null) => ({ file: "thread", offset: 9, raw: JSON.stringify({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status, error } } }) });
    expect(parseCodexLine(end("failed", { message: "No quota" }))[0]).toMatchObject({ kind: "session_note", payload: { text: "No quota" } });
    expect(parseCodexLine(end("interrupted"))[0]!.kind).toBe("session_note");
    expect(parseCodexLine({ file: "thread", offset: 1, raw: JSON.stringify({ method: "thread/status/changed", params: {} }) })).toEqual([]);
    expect(parseCodexLine({ file: "thread", offset: 1, raw: "not json" })).toEqual([]);
  });

  it("marks a command that exited non-zero as an error", () => {
    const item = { type: "commandExecution", id: "c", command: "false", cwd: "/", aggregatedOutput: "boom", exitCode: 1, status: "failed" };
    const [, result] = parseCodexLine({ file: "thread", offset: 0, raw: JSON.stringify({ method: "item/completed", params: { threadId: "t", item } }) });
    expect(result!.payload).toMatchObject({ is_error: true, content: "boom" });
  });
});

describe("codex line dispatch", () => {
  it("is picked by the session's harness, and notes an oversize line", () => {
    expect(eventsForHarness("codex", lines[0]!)[0]!.kind).toBe("user_message");
    expect(codexEventsFor({ file: "thread", offset: 2, oversizeBytes: 5 })[0]).toMatchObject({ kind: "session_note" });
  });
});
