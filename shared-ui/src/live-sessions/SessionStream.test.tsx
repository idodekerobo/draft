import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionStream } from "./SessionStream";
import { buildStreamItems } from "./stream-items";
import type { LiveSessionEvent, LiveSessionEventKind, LiveSessionEventPayload } from "./types";

afterEach(cleanup);

function Stream({ events, ...rest }: { events: LiveSessionEvent[]; ownerName?: string; hostName?: string | null }) {
  return <SessionStream items={buildStreamItems(events)} {...rest} />;
}

let seq = 0;
const event = (kind: LiveSessionEventKind, payload: LiveSessionEventPayload): LiveSessionEvent => ({
  seq: ++seq,
  source_id: `s${seq}`,
  kind,
  payload,
  created_at: "2026-10-26T20:00:00.000Z",
});

describe("SessionStream", () => {
  it("shows a waiting line before the first event", () => {
    render(<Stream events={[]} />);
    expect(screen.getByRole("status").textContent).toContain("Waiting");
  });

  it("labels the owner's turn, renders assistant markdown, and shows a tool call with its output", () => {
    const { container } = render(
      <Stream
        ownerName="Maya"
        events={[
          event("user_message", { text: "list files" }),
          event("assistant_text", { text: "Here are **two** files" }),
          event("tool_use", { tool_use_id: "t1", name: "Bash", input: { command: "ls" } }),
          event("tool_result", { tool_use_id: "t1", content: "a.txt\nb.txt" }),
        ]}
      />,
    );
    expect(screen.getByText("Maya")).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("two");
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(container.textContent).toContain("a.txt");
  });

  it("escapes HTML in assistant text instead of rendering it", () => {
    const { container } = render(<Stream events={[event("assistant_text", { text: "<img src=x onerror=alert(1)>" })]} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("marks a tool call as running until its result arrives, and a failed one as failed", () => {
    const { container, rerender } = render(<Stream events={[event("tool_use", { tool_use_id: "t9", name: "Bash", input: { command: "x" } })]} />);
    expect(container.textContent).toContain("running");
    rerender(
      <Stream
        events={[
          event("tool_use", { tool_use_id: "t9", name: "Bash", input: { command: "x" } }),
          event("tool_result", { tool_use_id: "t9", content: "nope", is_error: true }),
        ]}
      />,
    );
    expect(container.textContent).toContain("failed");
  });

  it("labels the first item of a sub-agent run once", () => {
    render(
      <Stream
        events={[
          event("assistant_text", { text: "one", agent_id: "a1" }),
          event("assistant_text", { text: "two", agent_id: "a1" }),
          event("assistant_text", { text: "root" }),
        ]}
      />,
    );
    expect(screen.getAllByText("Sub-agent")).toHaveLength(1);
  });
});
