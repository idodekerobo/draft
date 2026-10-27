import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { SessionView } from "./SessionView";
import type { LiveSession, LiveSessionsApi } from "./types";

afterEach(cleanup);

const render = (ui: ReactElement) =>
  renderUi(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

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
    inputs: [],
  }),
  sendMessage: async () => {},
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
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ session: ended, events: [], inputs: [] }) }} sessionId="s1" />);
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
    render(<SessionView api={{ ...api, decideApproval, fetchEvents: async () => ({ session, events, inputs: [] }) }} sessionId="s1" />);
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

  it("shows waiting messages from the same poll as the events, and fetches again right after a send", async () => {
    const waiting = { id: "i1", author_user_id: "u2", author_name: "Priya", text: "run tests", state: "queued" as const, reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mine: true };
    let fetches = 0;
    const sendMessage = mock(async () => {});
    render(<SessionView api={{ ...api, sendMessage, fetchEvents: async () => (fetches++, { session, events: [], inputs: [waiting] }) }} sessionId="s1" />);
    await screen.findByText(/Queued/);
    const before = fetches;
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "next" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("s1", "next"));
    await waitFor(() => expect(fetches).toBeGreaterThan(before));
  });

  it("shows the page frame while the first page loads, with no text that later changes", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((done) => (release = done));
    const { container } = render(
      <SessionView api={{ ...api, fetchEvents: async () => (await slow, { session, events: [], inputs: [] }) }} sessionId="s1" back={<a href="/sessions">Sessions</a>} />,
    );
    expect(container.querySelector(".ui-session[aria-busy='true'] .ui-session__header")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    release();
    expect((await screen.findByRole("heading", { name: "fix login" })).textContent).toBe("fix login");
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("says when the session cannot be loaded and offers a retry", async () => {
    const failing = mock(async () => {
      throw new Error("boom");
    });
    render(<SessionView api={{ ...api, fetchEvents: failing }} sessionId="s1" />);
    expect(await screen.findByText(/Could not load this session/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows one banner line when the host is offline, and says the message waits", async () => {
    const offline: LiveSession = { ...session, status: "host_offline" };
    const queued = { id: "i1", author_user_id: "u2", author_name: "Dev", text: "hi", state: "queued" as const, reason: null, created_at: new Date().toISOString(), updated_at: "", mine: false };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ session: offline, events: [], inputs: [queued] }) }} sessionId="s1" />);
    expect((await screen.findByText(/computer is offline/)).textContent).toBe("Maya's computer is offline. Messages wait until it is back.");
    expect(screen.getByText("Queued, Maya's laptop is offline")).toBeTruthy();
    expect(screen.getByText(/· Host offline/)).toBeTruthy();
  });

  it("warns about a Claude version outside the tested range", async () => {
    const old: LiveSession = { ...session, harness_version: "2.2.0" };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ session: old, events: [], inputs: [] }) }} sessionId="s1" />);
    expect((await screen.findByText(/Claude Code 2\.2\.0/)).textContent).toContain("tested with 2.1.x");
  });

  it("links a cleared session to the one that continued it, and back", async () => {
    const cleared: LiveSession = { ...session, status: "ended", next_session: { id: "s2", title: "new chat", folder_name: "marigold" } };
    const onOpenSession = mock((_id: string) => {});
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ session: cleared, events: [], inputs: [] }) }} sessionId="s1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "new chat" }));
    expect(onOpenSession).toHaveBeenCalledWith("s2");
    cleanup();

    const next: LiveSession = { ...session, previous_session: { id: "s0", title: "old chat", folder_name: null } };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ session: next, events: [], inputs: [] }) }} sessionId="s1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "old chat" }));
    expect(onOpenSession).toHaveBeenCalledWith("s0");
  });

  it("puts the cursor in the message box for a session the person just started", async () => {
    render(<SessionView api={api} sessionId="s1" autoFocusComposer />);
    const box = await screen.findByLabelText(/Message to Maya's session/);
    expect(document.activeElement).toBe(box);
  });
});
