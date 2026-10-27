import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionView } from "./SessionView";
import type { LiveSession, LiveSessionsApi } from "./types";

afterEach(cleanup);

const session: LiveSession = {
  id: "s1", owner_user_id: "u1", owner_name: "Maya", title: "[Maya via Draft] fix login", folder_name: "marigold",
  host_name: null, status: "live", started_at: "2026-10-27T00:00:00Z", ended_at: null, last_event_at: null, last_seq: 2,
};

const api: LiveSessionsApi = {
  listSessions: async () => [session],
  fetchEvents: async () => ({
    session,
    events: [
      { seq: 1, source_id: "a", kind: "user_message", payload: { text: "[Priya via Draft] hello" }, created_at: "" },
      { seq: 2, source_id: "b", kind: "assistant_text", payload: { text: "Hi there" }, created_at: "" },
    ],
  }),
  sendMessage: async () => {},
  listInputs: async () => [],
  actOnInput: async () => {},
  decideApproval: async () => ({ ok: true }),
  stop: async () => {},
};

describe("SessionView", () => {
  it("shows a breadcrumb with the clean title, the folder above the message box, and right-aligned human messages", async () => {
    const { container } = render(<SessionView api={api} sessionId="s1" back={<a href="/sessions">Sessions</a>} />);
    expect((await screen.findByRole("heading", { name: "fix login" })).textContent).toBe("fix login");
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(container.querySelector(".ui-composer__folder")?.textContent).toBe("marigold");
    expect(container.querySelector(".ui-stream__item--human .ui-stream__bubble")?.textContent).toBe("hello");
    expect(screen.getByText("Priya")).toBeTruthy();
    expect(container.querySelector(".ui-stream__item--assistant .ui-stream__who")).toBeNull();
  });

  it("puts menu actions behind a menu button and closes it on Escape", async () => {
    let opened = 0;
    render(<SessionView api={api} sessionId="s1" back={<a href="/sessions">Sessions</a>} menuItems={() => [{ label: "Open in Terminal", onSelect: () => opened++ }]} />);
    const trigger = await screen.findByRole("button", { name: "Session options" });
    expect(screen.queryByRole("menuitem")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Terminal" }));
    expect(opened).toBe(1);
  });

  it("shows no menu button when there are no actions", async () => {
    render(<SessionView api={api} sessionId="s1" back={<a href="/sessions">Sessions</a>} menuItems={() => []} />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByRole("button", { name: "Session options" })).toBeNull();
  });

  it("Stop asks the host to interrupt, then shows Stopping until it settles", async () => {
    const stop = mock(async () => {});
    render(<SessionView api={{ ...api, stop }} sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith("s1"));
    expect((await screen.findByRole("button", { name: "Stopping…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no Stop for an ended session", async () => {
    const ended = { ...session, status: "ended" as const };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ session: ended, events: [] }) }} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("shows an open request as a panel above the message box and a resolved one as a line in the stream", async () => {
    const events = [
      { seq: 1, source_id: "a", kind: "permission_request" as const, payload: { requestId: "r1", name: "Write", input: { file_path: "/a/one.txt" } }, created_at: "2026-10-27T10:00:00Z" },
      { seq: 2, source_id: "b", kind: "permission_resolved" as const, payload: { requestId: "r1", reason: "decided", decision: "allow" as const, by_name: "Dev" }, created_at: "2026-10-27T10:01:00Z" },
      { seq: 3, source_id: "c", kind: "permission_request" as const, payload: { requestId: "r2", name: "Bash", input: { command: "ls" } }, created_at: "2026-10-27T10:02:00Z" },
    ];
    const decideApproval = mock(async () => ({ ok: true as const }));
    render(<SessionView api={{ ...api, decideApproval, fetchEvents: async () => ({ session, events }) }} sessionId="s1" />);
    expect(await screen.findByRole("group", { name: "Permission request: Bash" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Permission request: Write" })).toBeNull();
    expect(screen.getByText(/Allowed by Dev/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("s1", "r2", "allow"));
  });

  it("asks before a menu action that needs confirming", async () => {
    let ended = 0;
    render(<SessionView api={api} sessionId="s1" menuItems={() => [{ label: "End session", confirm: "End this session?", onSelect: () => ended++ }]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Session options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "End session" }));
    expect(ended).toBe(0);
    expect(screen.getByText("End this session?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ended).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "End session" }));
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(ended).toBe(1);
  });
});
