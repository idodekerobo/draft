import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { SessionView } from "./SessionView";
import { SessionNotFoundError, type LiveSession, type LiveSessionsApi } from "./types";

afterEach(cleanup);

const render = (ui: ReactElement) =>
  renderUi(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const session: LiveSession = {
  id: "s1", owner_user_id: "u1", owner_name: "Maya", title: "[Maya via Draft] fix login", folder_name: "marigold",
  host_name: null, status: "live", started_at: "2026-10-27T00:00:00Z", ended_at: null, last_event_at: null, last_seq: 2,
};

const viewer = { id: "u9", name: "Dev" };

const api: LiveSessionsApi = {
  listSessions: async () => [session],
  fetchEvents: async () => ({ viewer,
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
  stop: async () => ({ withdrawn: [] }),
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
    const stop = mock(async () => ({ withdrawn: [] as string[] }));
    render(<SessionView api={{ ...api, stop }} sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith("s1"));
    expect((await screen.findByRole("button", { name: "Stopping…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Stop puts the messages it pulled back into the message box, ahead of what was typed", async () => {
    const stop = mock(async () => ({ withdrawn: ["first", "second"] }));
    render(<SessionView api={{ ...api, stop }} sessionId="s-restore" />);
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "typed" } });
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(box.value).toBe("first\n\nsecond\n\ntyped"));
  });

  it("shows no Stop for an ended session", async () => {
    const ended = { ...session, status: "ended" as const };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: ended, events: [], inputs: [] }) }} sessionId="s1" />);
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
    render(<SessionView api={{ ...api, decideApproval, fetchEvents: async () => ({ viewer, session, events, inputs: [] }) }} sessionId="s1" />);
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

  it("shows waiting messages as bubbles in the log from the same poll as the events, and fetches again right after a send", async () => {
    const waiting = { id: "i1", author_user_id: "u2", author_name: "Priya", text: "run tests", state: "queued" as const, reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mine: true };
    let fetches = 0;
    const sendMessage = mock(async () => {});
    render(<SessionView api={{ ...api, sendMessage, fetchEvents: async () => (fetches++, { viewer, session, events: [], inputs: [waiting] }) }} sessionId="s1" />);
    await screen.findByText("run tests");
    expect(screen.queryByText(/Queued/)).toBeNull();
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
      <SessionView api={{ ...api, fetchEvents: async () => (await slow, { viewer, session, events: [], inputs: [] }) }} sessionId="s1" back={<a href="/sessions">Sessions</a>} />,
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

  it("copies a message, copies a link to it, and shows when it was sent", async () => {
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const timed = { ...api, fetchEvents: async () => ({ viewer, session, inputs: [], events: [{ seq: 2, source_id: "b", kind: "assistant_text" as const, payload: { text: "Hi **there**" }, created_at: "2026-10-28T17:27:00.000Z" }] }) };
    const { container } = render(<SessionView api={timed} sessionId="s1" shareBaseUrl="https://app.example.com" />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hi **there**"));
    fireEvent.click(screen.getByRole("button", { name: "Copy link to message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://app.example.com/sessions/s1?m=2"));
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://app.example.com/sessions/s1"));
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-28T17:27:00.000Z");
  });

  it("hides the link actions when no share base url is given", async () => {
    render(<SessionView api={api} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy link to message" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy message" }).length).toBe(2);
  });

  it("scrolls to the focused message and highlights it", async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      const { container } = render(<SessionView api={api} sessionId="s1" focusSeq={1} />);
      await screen.findByRole("heading", { name: "fix login" });
      await waitFor(() => expect(scrolled).toEqual(["m-1"]));
      expect(container.querySelector("#m-1")?.className).toContain("ui-stream__item--highlight");
      expect(container.querySelector("#m-2")?.className).not.toContain("ui-stream__item--highlight");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("shows a no-access page, not a retry, when the session is not found", async () => {
    const missing = async () => {
      throw new SessionNotFoundError();
    };
    render(<SessionView api={{ ...api, fetchEvents: missing }} sessionId="s1" back={<a href="/sessions">Sessions</a>} noAccessNote="Signed in as dev@example.com" />);
    expect((await screen.findByRole("alert")).textContent).toContain("You don't have access to this session, or it doesn't exist.");
    expect(screen.getByText("Signed in as dev@example.com")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows a failed message with Resend in the message box area, not in the log", async () => {
    const failed = { id: "i1", author_user_id: "u2", author_name: "Dev", text: "hi", state: "failed" as const, reason: "session_ended", created_at: new Date().toISOString(), updated_at: "", mine: true };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session, events: [], inputs: [failed] }) }} sessionId="s1" />);
    expect(await screen.findByRole("button", { name: "Resend" })).toBeTruthy();
    expect(screen.getByText("Not delivered: the session ended")).toBeTruthy();
  });

  it("shows one banner line when the host is offline, and says the message waits", async () => {
    const offline: LiveSession = { ...session, status: "host_offline" };
    const queued = { id: "i1", author_user_id: "u2", author_name: "Dev", text: "hi", state: "queued" as const, reason: null, created_at: new Date().toISOString(), updated_at: "", mine: false };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: offline, events: [], inputs: [queued] }) }} sessionId="s1" />);
    expect((await screen.findByText(/computer is offline/)).textContent).toBe("Maya's computer is offline. Messages wait until it is back.");
    expect(screen.getByText("Queued, Maya's laptop is offline")).toBeTruthy();
    expect(screen.getByText(/· Host offline/)).toBeTruthy();
  });

  it("warns about a Claude version outside the tested range", async () => {
    const old: LiveSession = { ...session, harness_version: "2.2.0" };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: old, events: [], inputs: [] }) }} sessionId="s1" />);
    expect((await screen.findByText(/Claude Code 2\.2\.0/)).textContent).toContain("tested with 2.1.x");
  });

  it("links a cleared session to the one that continued it, and back", async () => {
    const cleared: LiveSession = { ...session, status: "ended", next_session: { id: "s2", title: "new chat", folder_name: "marigold" } };
    const onOpenSession = mock((_id: string) => {});
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: cleared, events: [], inputs: [] }) }} sessionId="s1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "new chat" }));
    expect(onOpenSession).toHaveBeenCalledWith("s2");
    cleanup();

    const next: LiveSession = { ...session, previous_session: { id: "s0", title: "old chat", folder_name: null } };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: next, events: [], inputs: [] }) }} sessionId="s1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "old chat" }));
    expect(onOpenSession).toHaveBeenCalledWith("s0");
  });

  it("puts the cursor in the message box for a session the person just started", async () => {
    render(<SessionView api={api} sessionId="s1" autoFocusComposer />);
    const box = await screen.findByLabelText(/Message to Maya's session/);
    expect(document.activeElement).toBe(box);
  });

  it("sends typing anywhere in the session to the message box", async () => {
    render(<SessionView api={api} sessionId="s1" />);
    const box = await screen.findByLabelText(/Message to Maya's session/);
    expect(document.activeElement).not.toBe(box);
    fireEvent.keyDown(document.body, { key: "c", metaKey: true });
    expect(document.activeElement).not.toBe(box);
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(document.activeElement).not.toBe(box);
    fireEvent.keyDown(document.body, { key: "h" });
    expect(document.activeElement).toBe(box);
  });

  it("leaves typing alone when another field has focus or the session has ended", async () => {
    const ended: LiveSession = { ...session, status: "ended" };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: ended, events: [], inputs: [] }) }} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    fireEvent.keyDown(other, { key: "h" });
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("shows who else is watching, and stops watching when the view closes", async () => {
    let push: (names: string[]) => void = () => {};
    const stop = mock(() => {});
    const watchPresence = mock((_id: string, _viewer: { id: string; name: string }, onChange: (names: string[]) => void) => {
      push = onChange;
      return stop;
    });
    const { unmount } = render(<SessionView api={{ ...api, watchPresence }} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(watchPresence.mock.calls[0]![1]).toEqual(viewer);
    expect(screen.queryByText(/watching/)).toBeNull();
    act(() => push(["Priya", "Sam"]));
    expect(screen.getByText("Priya and Sam are watching")).toBeTruthy();
    act(() => push([]));
    expect(screen.queryByText(/watching/)).toBeNull();
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("stops the turn when Esc is pressed in an empty message box, and not when it holds text", async () => {
    const stop = mock(async () => ({ withdrawn: [] as string[] }));
    render(<SessionView api={{ ...api, stop }} sessionId="s1" />);
    const box = await screen.findByRole("textbox");
    fireEvent.change(box, { target: { value: "draft" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(stop).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(stop).toHaveBeenCalledWith("s1"));
  });
});

describe("SessionView for a routine run", () => {
  const routineSession: LiveSession = { ...session, session_type: "routine", title: "Weekly digest", folder_name: null };
  const routineApi: LiveSessionsApi = { ...api, fetchEvents: async () => ({ viewer, session: routineSession, events: [], inputs: [] }) };

  it("shows the stream with no message box, no Stop, and says the run takes no messages", async () => {
    render(<SessionView api={routineApi} sessionId="s1" />);
    expect(await screen.findByRole("heading", { name: "Weekly digest" })).toBeTruthy();
    expect(screen.getByText(/Routine run/)).toBeTruthy();
    expect(screen.getByText("This run follows its routine on its own. It cannot take messages.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("SessionView view event", () => {
  const routineSession: LiveSession = { ...session, session_type: "routine", title: "Weekly digest" };
  const routineApi: LiveSessionsApi = { ...api, fetchEvents: async () => ({ viewer, session: routineSession, events: [], inputs: [] }) };

  it("reports a shared session once per open", async () => {
    const track = mock((_event: string, _props: unknown) => {});
    render(<SessionView api={api} sessionId="s1" track={track as never} />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]![0]).toBe("session_viewed");
  });

  it("does not report a routine run, even when the page passes a tracker", async () => {
    const track = mock((_event: string, _props: unknown) => {});
    render(<SessionView api={routineApi} sessionId="s1" track={track as never} />);
    await screen.findByRole("heading", { name: "Weekly digest" });
    expect(track).not.toHaveBeenCalled();
  });
});
