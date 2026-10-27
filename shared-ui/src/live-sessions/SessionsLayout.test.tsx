import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ColumnToggleButton, SessionsLayout } from "./SessionsLayout";
import type { LiveSession } from "./types";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const make = (id: string, title: string, started: Date, status: LiveSession["status"] = "live"): LiveSession => ({
  id, owner_user_id: "u", owner_name: "Maya", title, folder_name: "app", host_name: null, status,
  started_at: started.toISOString(), ended_at: null, last_event_at: null, last_seq: 0,
});
const NOW = new Date();
const sessions = [make("a", "[Maya via Draft] fix login", NOW), make("b", "write docs", new Date(NOW.getTime() - 5 * 86_400_000), "ended")];

function setup(props: Partial<Parameters<typeof SessionsLayout>[0]> = {}) {
  const onSelect = mock((_id: string) => {});
  const onNew = mock(() => {});
  const view = render(
    <SessionsLayout sessions={sessions} selectedId="a" onSelect={onSelect} onNew={onNew} resizable {...props}>
      <header><ColumnToggleButton where="main" /></header>
      <p>main content</p>
    </SessionsLayout>,
  );
  return { onSelect, onNew, ...view };
}

describe("SessionsLayout", () => {
  it("lists sessions in day groups with clean titles, owner and status words", () => {
    setup();
    expect(screen.getByRole("region", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Earlier" })).toBeTruthy();
    expect(screen.getByText("fix login")).toBeTruthy();
    expect(screen.getByText("Ended")).toBeTruthy();
    expect(screen.getAllByText("Maya").length).toBe(2);
  });

  it("marks the open session and selects a row on click", () => {
    const { onSelect } = setup();
    expect(screen.getByRole("button", { name: /fix login/ }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /write docs/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("has a New session button that is current on the start screen, and none on web", () => {
    const { onNew } = setup({ selectedId: null });
    const button = screen.getByRole("button", { name: "New session" });
    expect(button.getAttribute("aria-current")).toBe("true");
    fireEvent.click(button);
    expect(onNew).toHaveBeenCalled();
    cleanup();
    setup({ onNew: undefined });
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  });

  it("shows loading, failed and empty states", () => {
    setup({ sessions: [], loading: true });
    expect(screen.getByRole("status").textContent).toContain("Loading");
    cleanup();
    setup({ sessions: [], failed: true });
    expect(screen.getByRole("alert").textContent).toContain("Could not load");
    cleanup();
    setup({ sessions: [] });
    expect(screen.getByRole("status").textContent).toContain("No sessions yet");
  });

  it("hides and shows the column with the button and with Cmd+B, one twin button at a time", () => {
    const { container } = setup();
    const column = container.querySelector("#sessions-column")!;
    expect(column.getAttribute("data-open")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Hide sessions list" }).length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Hide sessions list" }));
    expect(column.getAttribute("data-open")).toBe("false");
    expect(screen.getAllByRole("button", { name: "Show sessions list" }).length).toBe(1);
    expect(screen.queryByRole("button", { name: "Hide sessions list" })).toBeNull();

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(column.getAttribute("data-open")).toBe("true");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(column.getAttribute("data-open")).toBe("false");
  });

  it("remembers the hidden state and width", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Hide sessions list" }));
    expect(window.localStorage.getItem("draft.sessions.columnOpen")).toBe("0");
    cleanup();
    const { container } = setup();
    expect(container.querySelector("#sessions-column")!.getAttribute("data-open")).toBe("false");
  });

  it("resets the width on a double-click of the handle", () => {
    window.localStorage.setItem("draft.sessions.columnWidth", "330");
    const { container } = setup();
    const layout = container.querySelector(".ui-sessions") as HTMLElement;
    expect(layout.style.getPropertyValue("--sessions-col-w")).toBe("330px");
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(layout.style.getPropertyValue("--sessions-col-w")).toBe("260px");
  });

  it("has no resize handle unless resizable", () => {
    setup({ resizable: false });
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("filters to the caller's sessions on the Mine tab, without changing the list on All", () => {
    setup({ sessions: [{ ...sessions[0]!, mine: true }, { ...sessions[1]!, mine: false }] });
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("write docs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(screen.getByRole("button", { name: "Mine" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("write docs")).toBeNull();
    expect(screen.getByText("fix login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("write docs")).toBeTruthy();
  });

  it("says what to do in an empty list, by platform and tab", () => {
    setup({ sessions: [] });
    expect(screen.getByRole("status").textContent).toBe("No sessions yet.");
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(screen.getByRole("status").textContent).toBe("You haven't started a session.");
    cleanup();
    setup({ sessions: [], onNew: undefined });
    expect(screen.getByRole("status").textContent).toBe("Sessions start in the Draft desktop app. Your team's sessions show here.");
  });

  it("shows the display status, with Waiting for approval and Host offline in words", () => {
    setup({ sessions: [{ ...sessions[0]!, open_approval_count: 1 }, { ...sessions[1]!, status: "host_offline" }] });
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByText("Host offline")).toBeTruthy();
  });
});
