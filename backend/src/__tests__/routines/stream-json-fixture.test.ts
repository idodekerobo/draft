import { expect, it } from "bun:test";
import { eventsFor } from "../../ingestion/claude-code/live-lines";
import { StreamLineReader } from "../../sandbox/claude-code/runner";

// The shape `claude -p --output-format stream-json --verbose` prints, one JSON object per line.
const STREAM = [
  { type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-4-5", tools: ["Read", "Glob"] },
  { type: "assistant", uuid: "u-1", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "I will read the product notes." }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/run/input/context/product.md" } }] } },
  { type: "user", uuid: "u-2", session_id: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "# Product\nWe ship weekly." }] } },
  { type: "assistant", uuid: "u-3", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "The team ships weekly." }] } },
  { type: "result", subtype: "success", is_error: false, result: "The team ships weekly." },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

it("maps runner lines from a stream-json run to the same events the live viewer shows", () => {
  const lines = new StreamLineReader().push(STREAM);
  const events = lines.flatMap(eventsFor);

  expect(events.map((e) => e.kind)).toEqual(["assistant_text", "tool_use", "tool_result", "assistant_text"]);
  expect(events.map((e) => e.sourceId)).toEqual(["u-1", "u-1#1", "u-2", "u-3"]);
  expect(events[1]!.payload).toMatchObject({ tool_use_id: "toolu_1", name: "Read" });
  expect(events[2]!.payload).toMatchObject({ tool_use_id: "toolu_1", is_error: false });
});

it("sends the same line to the same event ids when the stream is chunked differently", () => {
  const reader = new StreamLineReader();
  const chunked = [STREAM.slice(0, 57), STREAM.slice(57, 300), STREAM.slice(300)].flatMap((chunk) => reader.push(chunk));
  expect(chunked.flatMap(eventsFor).map((e) => e.sourceId)).toEqual(["u-1", "u-1#1", "u-2", "u-3"]);
});
