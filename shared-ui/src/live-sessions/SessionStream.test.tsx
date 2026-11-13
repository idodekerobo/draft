import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionStream } from "./SessionStream";
import { buildStreamItems } from "./stream-items";
import type { ComposerInput, LiveSessionEvent, LiveSessionEventKind, LiveSessionEventPayload } from "./types";

afterEach(cleanup);

function Stream({ events, ...rest }: { events: LiveSessionEvent[]; ownerName?: string; hostName?: string | null; viewerId?: string; viewerName?: string; viewerIsOwner?: boolean }) {
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
  it("shows a live preview last, with the markup of a stored assistant message", () => {
    const events = [event("user_message", { text: "list files" }), event("assistant_text", { text: "Here are two" })];
    const { container } = render(<SessionStream items={[...buildStreamItems(events), { type: "live", messageId: "m1", text: "Checking **now**" }]} />);
    const rows = container.querySelectorAll("li.ui-stream__item");
    const last = rows[rows.length - 1]!;
    expect(last.className).toContain("ui-stream__item--assistant");
    expect(last.id).toBe("");
    expect(last.querySelector(".ui-prose strong")?.textContent).toBe("now");
  });

  it("shows an agent's message as an expandable row, not as a person's bubble", () => {
    const { container } = render(
      <Stream
        events={[event("session_note", { text: "Message from test-updater", agent_message: { from: "test-updater", type: "idle", text: "Core tests **pass**" } })]}
      />,
    );
    expect(container.querySelector(".ui-stream__bubble")).toBeNull();
    const summary = container.querySelector(".ui-stream__item--agent_message summary")!;
    expect(summary.textContent).toContain("Agent");
    expect(summary.textContent).toContain("@test-updater finished");
    expect(container.querySelector(".ui-stream__agent-body strong")?.textContent).toBe("pass");
  });

  it("names a team agent in its block header", () => {
    const { container } = render(
      <Stream
        events={[
          event("tool_use", { tool_use_id: "t1", name: "Agent", input: { name: "cli-routines", description: "Rewrite CLI", prompt: "go" } }),
          event("tool_result", { tool_use_id: "t1", content: "Spawned.\nagent_id: a-1" }),
          event("assistant_text", { text: "On it", agent_id: "a-1" }),
        ]}
      />,
    );
    expect(container.querySelector("summary")?.textContent).toContain("@cli-routines");
  });

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

  it("puts a teammate's message on the left with their name, and hides the label on the viewer's own", () => {
    const { container } = render(
      <Stream
        viewerId="u1"
        viewerName="Maya"
        viewerIsOwner
        events={[
          { ...event("user_message", { text: "[Priya via Draft] from priya" }), author_user_id: "u2" },
          { ...event("user_message", { text: "[Maya via Draft] from maya" }), author_user_id: "u1" },
          event("assistant_text", { text: "ok" }),
        ]}
      />,
    );
    const rows = Array.from(container.querySelectorAll("li.ui-stream__item--human"));
    expect(rows.map((r) => r.classList.contains("ui-stream__item--theirs"))).toEqual([true, false]);
    expect(screen.getByText("Priya")).toBeTruthy();
    expect(screen.queryByText("Maya")).toBeNull();
    expect(container.querySelector("li.ui-stream__item--assistant")?.className).not.toContain("--theirs");
  });

  it("shows a teammate's current name over the one saved in the message text", () => {
    render(<Stream viewerId="u1" events={[{ ...event("user_message", { text: "[priya@example.test via Draft] hi" }), author_user_id: "u2", author_name: "Priya Shah" }]} />);
    expect(screen.getByText("Priya Shah")).toBeTruthy();
    expect(screen.queryByText("priya@example.test")).toBeNull();
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

  it("groups a sub-agent run with no launching call in one block of its own", () => {
    const { container } = render(
      <Stream
        events={[
          event("assistant_text", { text: "one", agent_id: "a1" }),
          event("assistant_text", { text: "two", agent_id: "a1" }),
          event("assistant_text", { text: "root" }),
        ]}
      />,
    );
    expect(screen.getAllByText("Sub-agent")).toHaveLength(1);
    expect(container.querySelectorAll(".ui-stream__nested > li")).toHaveLength(2);
  });

  it("nests a sub-agent's items under the call that launched it, with a bold title", () => {
    const items = buildStreamItems([
      { seq: 1, source_id: "a", kind: "tool_use", payload: { tool_use_id: "t1", name: "Agent", input: { description: "Scan inbox", prompt: "Read it" } }, created_at: "" },
      { seq: 2, source_id: "b", kind: "assistant_text", payload: { text: "inner note", agent_id: "a1" }, created_at: "" },
      { seq: 3, source_id: "c", kind: "tool_result", payload: { tool_use_id: "t1", content: "Async agent launched.\nagentId: a1 (internal)" }, created_at: "" },
    ]);
    expect(items).toHaveLength(1);
    const { container } = render(<SessionStream items={items} />);
    const title = screen.getByText("Scan inbox");
    expect(title.className).toContain("ui-stream__summary--title");
    expect(container.querySelectorAll("details")).toHaveLength(1);
    expect(container.querySelector(".ui-stream__nested")?.textContent).toContain("inner note");
  });

  it("does not claim a run for a non-agent tool that quotes an agent id", () => {
    const items = buildStreamItems([
      { seq: 1, source_id: "a", kind: "tool_use", payload: { tool_use_id: "t1", name: "Bash", input: { command: "grep" } }, created_at: "" },
      { seq: 2, source_id: "b", kind: "tool_result", payload: { tool_use_id: "t1", content: "agentId: a1" }, created_at: "" },
      { seq: 3, source_id: "c", kind: "assistant_text", payload: { text: "inner", agent_id: "a1" }, created_at: "" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: "tool", name: "Sub-agent" });
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

  it("lets the sender cancel a queued message, and points a blocked one at the open request", () => {
    const base: ComposerInput = { id: "i1", author_user_id: "u1", author_name: "Priya", text: "run tests", state: "queued", reason: "question_prompt", created_at: new Date().toISOString(), updated_at: "", mine: true };
    const pending = (input: ComposerInput) => ({ type: "pending", key: "i1", input, author: "Priya", ownerName: "Maya", hostOffline: false }) as const;
    const onCancel = mock((_id: string) => {});
    const onShowRequest = mock(() => {});
    const onSkipQuestions = mock(() => {});
    const view = render(<SessionStream items={[pending(base)]} onCancel={onCancel} onShowRequest={onShowRequest} onSkipQuestions={onSkipQuestions} />);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(onSkipQuestions).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith("i1");

    view.rerender(<SessionStream items={[pending({ ...base, reason: "permission_prompt" })]} onCancel={onCancel} onShowRequest={onShowRequest} />);
    fireEvent.click(screen.getByRole("button", { name: "Review it" }));
    expect(onShowRequest).toHaveBeenCalledTimes(1);
    view.rerender(<SessionStream items={[pending({ ...base, mine: false })]} onCancel={onCancel} onShowRequest={onShowRequest} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    view.rerender(<SessionStream items={[pending({ ...base, state: "delivering", reason: null })]} onCancel={onCancel} onShowRequest={onShowRequest} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("offers the owner a way to dismiss a prompt that blocks a queued message", () => {
    const base: ComposerInput = { id: "i1", author_user_id: "u1", author_name: "Priya", text: "run tests", state: "queued", reason: "dialog", created_at: new Date().toISOString(), updated_at: "", mine: true };
    const item = { type: "pending", key: "i1", input: base, author: "Priya", ownerName: "Maya", hostOffline: false } as const;
    const onDismissPrompt = mock(() => {});
    const view = render(<SessionStream items={[item]} onDismissPrompt={onDismissPrompt} />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss in terminal/ }));
    expect(onDismissPrompt).toHaveBeenCalledTimes(1);
    view.rerender(<SessionStream items={[{ ...item, input: { ...base, reason: "composer_busy" } }]} onDismissPrompt={onDismissPrompt} />);
    expect(screen.queryByRole("button", { name: /Dismiss in terminal/ })).toBeNull();
  });

  it("shows an approved plan's tool row as formatted text, open", () => {
    const items = buildStreamItems([
      { seq: 1, source_id: "a", kind: "tool_use", payload: { tool_use_id: "t1", name: "ExitPlanMode", input: { plan: "# Plan\n\n1. Write it" } }, created_at: "" },
      { seq: 2, source_id: "b", kind: "tool_result", payload: { tool_use_id: "t1", content: "approved" }, created_at: "" },
    ]);
    const { container } = render(<SessionStream items={items} />);
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByText("Write it")).toBeTruthy();
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });
});
