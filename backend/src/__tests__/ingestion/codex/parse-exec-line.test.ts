import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { codexExecEventsFor, parseCodexExecLine } from "../../../ingestion/codex/parse-exec-line";
import { routineEventsForHarness } from "../../../ingestion/harness-lines";

const recorded = readFileSync(new URL("./exec-run.jsonl", import.meta.url), "utf8").trim().split("\n");
const lines = recorded.map((raw, offset) => ({ file: "exec.jsonl", offset, raw }));

describe("parseCodexExecLine", () => {
  const events = lines.flatMap(parseCodexExecLine);

  it("maps a recorded run to a tool call with its result, then the answer", () => {
    expect(events.map((e) => e.kind)).toEqual(["tool_use", "tool_result", "assistant_text"]);
    expect(events.at(-1)!.payload.text).toBe("It printed `hello-from-exec`.");
  });

  it("pairs the command with its output by item id and does not flag a clean exit", () => {
    const [use, result] = events;
    expect(use!.payload).toMatchObject({ name: "command", input: { command: "/bin/zsh -lc 'echo hello-from-exec'" } });
    expect(result!.payload).toMatchObject({ tool_use_id: use!.payload.tool_use_id, content: "hello-from-exec\n", is_error: false });
    expect(result!.sourceId).toBe(`${use!.sourceId}#1`);
  });

  it("gives every event a source id that is stable across parses", () => {
    expect(new Set(events.map((e) => e.sourceId)).size).toBe(events.length);
    expect(lines.flatMap(parseCodexExecLine).map((e) => e.sourceId)).toEqual(events.map((e) => e.sourceId));
  });

  it("shows nothing for the start of an item, a thread or a turn, or for usage", () => {
    for (const index of [0, 1, 2, 5]) expect(parseCodexExecLine(lines[index]!)).toEqual([]);
  });

  it("flags a command that exits with an error", () => {
    const raw = JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" } });
    const [, result] = parseCodexExecLine({ file: "exec.jsonl", offset: 7, raw });
    expect(result!.payload).toMatchObject({ is_error: true });
  });

  it("notes a failed turn and an error, and skips a line that is not JSON", () => {
    const note = (event: unknown) => parseCodexExecLine({ file: "exec.jsonl", offset: 9, raw: JSON.stringify(event) });
    expect(note({ type: "turn.failed", error: { message: "rate limited" } })[0]).toMatchObject({ kind: "session_note", payload: { text: "rate limited" } });
    expect(note({ type: "error", message: "stream closed" })[0]).toMatchObject({ kind: "session_note", payload: { text: "stream closed" } });
    expect(parseCodexExecLine({ file: "exec.jsonl", offset: 9, raw: "not json" })).toEqual([]);
  });

  it("notes a skipped oversize line, and a routine run picks this parser for Codex only", () => {
    expect(codexExecEventsFor({ file: "exec.jsonl", offset: 3, oversizeBytes: 9_000_000 })[0]).toMatchObject({ kind: "session_note", payload: { reason: "too_large" } });
    expect(routineEventsForHarness("codex", lines[4]!).map((e) => e.kind)).toEqual(["assistant_text"]);
    const claudeLine = { file: "root.jsonl", offset: 0, raw: JSON.stringify({ type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }) };
    expect(routineEventsForHarness("claude", claudeLine).map((e) => e.kind)).toEqual(["assistant_text"]);
  });
});
