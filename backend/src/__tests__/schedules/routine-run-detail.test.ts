import { describe, expect, it } from "bun:test";
import { readRunTranscript } from "../../schedules/routine-run-detail";
import { fakeClient, fakeDb } from "../routines/fake-client";

const event = (seq: number, kind: string, payload: Record<string, unknown>) => ({ session_id: "s-1", workspace_id: "ws-1", seq, kind, payload });

describe("readRunTranscript", () => {
  it("turns events into short lines, clips tool output and leaves out thinking and previews", async () => {
    const db = fakeDb({ session_events: [
      event(1, "user_message", { text: "Summarize the week." }),
      event(2, "thinking", { text: "hmm" }),
      event(3, "assistant_text", { text: "draft", preview: true }),
      event(4, "tool_use", { name: "Read", input: { path: "a.md" } }),
      event(5, "tool_result", { content: "x".repeat(3000) }),
      event(6, "assistant_text", { text: "Done." }),
    ] });
    const page = await readRunTranscript(fakeClient(db), "ws-1", "s-1");
    expect(page.nextCursor).toBeNull();
    expect(page.lines[0]).toBe("Prompt: Summarize the week.");
    expect(page.lines[1]).toBe('Tool Read: {"path":"a.md"}');
    expect(page.lines[2]).toContain("[1000 more characters]");
    expect(page.lines[3]).toBe("Agent: Done.");
    expect(page.lines).toHaveLength(4);
  });

  it("pages a long run, and the next page starts where the last one stopped", async () => {
    const db = fakeDb({ session_events: Array.from({ length: 30 }, (_, index) => event(index + 1, "assistant_text", { text: `${index + 1} ${"y".repeat(1900)}` })) });
    const first = await readRunTranscript(fakeClient(db), "ws-1", "s-1");
    expect(first.nextCursor).not.toBeNull();
    const second = await readRunTranscript(fakeClient(db), "ws-1", "s-1", first.nextCursor!);
    expect(second.lines[0]!.startsWith(`Agent: ${first.nextCursor! + 1} `)).toBe(true);
    const all = [...first.lines, ...second.lines];
    for (let cursor = second.nextCursor; cursor !== null;) {
      const page = await readRunTranscript(fakeClient(db), "ws-1", "s-1", cursor);
      all.push(...page.lines);
      cursor = page.nextCursor;
    }
    expect(all.map((line) => Number(line.split(" ")[1]))).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
  });
});
