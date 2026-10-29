import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionStream } from "./SessionStream";
import { buildStreamItems } from "./stream-items";
import type { ComposerInput, LiveSessionEvent, LiveSessionEventKind, LiveSessionEventPayload } from "./types";

afterEach(cleanup);

function Stream({ events, ...rest }: { events: LiveSessionEvent[]; ownerName?: string; hostName?: string | null; viewerId?: string }) {
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

  it("tells the person who pressed Stop apart from everyone else", () => {
    const events = [event("session_note", { text: "Stopped by Dev", interrupted_by: { id: "u1", name: "Dev" } })];
    const { rerender } = render(<Stream events={events} viewerId="u1" />);
    expect(screen.getByText("You interrupted")).toBeTruthy();
    rerender(<Stream events={events} viewerId="u2" />);
    expect(screen.getByText("Interrupted by Dev")).toBeTruthy();
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

  it("shows a pending message as a bubble with no note, then a note when it is blocked", () => {
    const base: ComposerInput = { id: "i1", author_user_id: "u1", author_name: "Priya", text: "run tests", state: "queued", reason: null, created_at: new Date().toISOString(), updated_at: "", mine: true };
    const pending = (input: ComposerInput, hostOffline = false) =>
      ({ type: "pending", key: "i1", input, author: "Priya", ownerName: "Maya", hostOffline }) as const;
    const view = render(<SessionStream items={[pending(base)]} />);
    expect(screen.getByText("run tests")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<SessionStream items={[pending({ ...base, reason: "composer_busy" })]} />);
    expect(screen.getByRole("status").textContent).toBe("Queued, Maya is typing in the terminal");
    view.rerender(<SessionStream items={[pending(base, true)]} />);
    expect(screen.getByRole("status").textContent).toBe("Queued, Maya's laptop is offline");
  });
});
