import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { SessionView } from "./SessionView";
import { messageDomId } from "./share-links";
import { SessionNotFoundError, type LiveSession, type LiveSessionEvent, type LiveSessionsApi } from "./types";
import type { LiveTextChunk } from "draft-core/live-sessions";

afterEach(cleanup);

const render = (ui: ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  renderUi(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

/** The test DOM has no layout: every element gets one scroll height and view, and scrollTop stops at the bottom. */
function fakeScrollGeometry(height = 1000, view = 100) {
  const tops = new WeakMap<Element, number>();
  const names = ["scrollTop", "scrollHeight", "clientHeight"] as const;
  const before = names.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => view },
    scrollTop: {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
      },
      set(this: Element, top: number) {
        tops.set(this, Math.min(Math.max(top, 0), height - view));
      },
    },
  });
  return () => {
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  };
}

const session: LiveSession = {
  id: "s1", owner_user_id: "u1", owner_name: "Maya", title: "[Maya via Draft] fix login", folder_name: "marigold",
  host_name: null, status: "live", started_at: "2026-10-27T00:00:00Z", ended_at: null, last_event_at: null, last_seq: 1,
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
  setMode: async () => {},
};

describe("SessionView", () => {
  it("shows a breadcrumb with the clean title, no folder above the message box, and right-aligned human messages", async () => {
    const { container } = render(<SessionView api={api} sessionId="s1" back={<a href="/sessions">Sessions</a>} />);
    expect((await screen.findByRole("heading", { name: "fix login" })).textContent).toBe("fix login");
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(container.querySelector(".ui-composer__folder")).toBeNull();
    expect(container.querySelector(".ui-stream__item--human .ui-stream__bubble")?.textContent).toBe("hello");
    expect(screen.getByText("Priya")).toBeTruthy();
    expect(container.querySelector(".ui-stream__item--assistant .ui-stream__who")).toBeNull();
  });

  it("names the harness and model in the header, and shows no Claude version warning for a Codex session", async () => {
    const codex: LiveSession = { ...session, harness: "codex", model: "gpt-6-luna", harness_version: "0.165.0" };
    const { container } = render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: codex, events: [], inputs: [] }) }} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    const lines = [...container.querySelectorAll(".ui-session__meta")].map((line) => line.textContent);
    expect(lines[0]).toContain("Maya");
    expect(lines[1]).toBe("Codex · GPT-6-Luna");
    expect(screen.queryByText(/Draft was tested with/)).toBeNull();
  });

  it("offers Send now on the caller's own busy-queued message in a session that can steer, and not in one that cannot", async () => {
    const waiting = { id: "i1", author_user_id: "u9", author_name: "Dev", text: "also run lint", state: "queued" as const, reason: "composer_busy", created_at: "2026-10-27T00:00:00Z", updated_at: "", mine: true };
    const actOnInput = mock(async () => {});
    const withSession = (live: LiveSession) => ({ ...api, actOnInput, fetchEvents: async () => ({ viewer, session: live, events: [], inputs: [waiting] }) });

    render(<SessionView api={withSession({ ...session, harness: "codex" })} sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await waitFor(() => expect(actOnInput).toHaveBeenCalledWith("s1", "i1", "steer"));
    expect(screen.getByText("Queued, Codex is working")).toBeTruthy();
    cleanup();

    render(<SessionView api={withSession({ ...session, harness: "claude" })} sessionId="s1" />);
    await screen.findByText(/typing in the terminal/);
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("shows the link action as an icon with a label", async () => {
    render(<SessionView api={api} sessionId="s1" shareBaseUrl="https://draft.test" />);
    const button = await screen.findByRole("button", { name: "Copy link" });
    expect(button.textContent).toBe("");
  });

  it("offers Resume to the owner of an ended session, shows why it failed, and hides it from others and for a cleared one", async () => {
    const ended: LiveSession = { ...session, status: "ended", mine: true, end_reason: "exited" };
    const resume = mock(async () => { throw new Error("This session ran on another computer. Resume it there."); });
    const withSession = (live: LiveSession, extra: Partial<LiveSessionsApi> = {}) => ({ ...api, ...extra, fetchEvents: async () => ({ viewer, session: live, events: [], inputs: [] }) });

    render(<SessionView api={withSession(ended, { resume })} sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith("s1"));
    expect((await screen.findByRole("alert")).textContent).toContain("another computer");
    cleanup();

    render(<SessionView api={withSession({ ...ended, mine: false }, { resume })} sessionId="s1" />);
    await screen.findByText(/This session has ended/);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    cleanup();

    render(<SessionView api={withSession({ ...ended, end_reason: "cleared" }, { resume })} sessionId="s1" />);
    await screen.findByText(/This session has ended/);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    cleanup();

    render(<SessionView api={withSession(ended)} sessionId="s1" />);
    await screen.findByText(/This session has ended/);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("offers Continue in chat on a finished routine run, opens the new chat, and shows why a start was refused", async () => {
    const run: LiveSession = { ...session, session_type: "routine", status: "ended", mine: false };
    const continueInChat = mock(async (_id: string) => "new-chat");
    const onOpenSession = mock((_id: string) => {});
    const withRun = (live: LiveSession, extra: Partial<LiveSessionsApi> = {}) => ({ ...api, ...extra, fetchEvents: async () => ({ viewer, session: live, events: [], inputs: [] }) });

    render(<SessionView api={withRun(run, { continueInChat })} sessionId="s1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue in chat" }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("new-chat"));
    expect(continueInChat).toHaveBeenCalledWith("s1");
    cleanup();

    const refused = mock(async (_id: string) => { throw new Error("routine_run_not_finished"); });
    render(<SessionView api={withRun(run, { continueInChat: refused })} sessionId="s1" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue in chat" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Wait for this run to finish");
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    cleanup();

    render(<SessionView api={withRun({ ...run, status: "live" }, { continueInChat })} sessionId="s1" />);
    await screen.findByText(/This run follows its routine/);
    expect(screen.queryByRole("button", { name: "Continue in chat" })).toBeNull();
    cleanup();

    render(<SessionView api={withRun({ ...run, session_type: "interactive" }, { continueInChat })} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByRole("button", { name: "Continue in chat" })).toBeNull();
    cleanup();

    render(<SessionView api={withRun(run)} sessionId="s1" />);
    await screen.findByText(/This run follows its routine/);
    expect(screen.queryByRole("button", { name: "Continue in chat" })).toBeNull();
    cleanup();

    render(<SessionView api={withRun({ ...run, end_reason: "skipped" }, { continueInChat })} sessionId="s1" />);
    await screen.findByText(/This run follows its routine/);
    expect(screen.queryByRole("button", { name: "Continue in chat" })).toBeNull();
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

  it("shows a chip for each team agent above the message box, opens its block on click, and hides the chips once the session ended", async () => {
    const events: LiveSessionEvent[] = [
      { seq: 1, source_id: "a", kind: "tool_use", payload: { tool_use_id: "t1", name: "Agent", input: { name: "cli-routines", description: "Rewrite CLI", prompt: "go" } }, created_at: "" },
      { seq: 2, source_id: "b", kind: "tool_result", payload: { tool_use_id: "t1", content: "Spawned.\nagent_id: a-1" }, created_at: "" },
      { seq: 3, source_id: "c", kind: "assistant_text", payload: { text: "On it", agent_id: "a-1" }, created_at: "" },
    ];
    const fetchEvents = (s: LiveSession) => async () => ({ viewer, session: s, events, inputs: [] });
    const { container, unmount } = render(<SessionView api={{ ...api, fetchEvents: fetchEvents(session) }} sessionId="s1" />);
    const chip = await screen.findByRole("button", { name: /@cli-routines/ });
    expect(chip.textContent).toContain("working");
    expect(container.querySelector(".ui-session__footer .ui-team")).not.toBeNull();
    fireEvent.click(chip);
    expect(container.querySelector<HTMLDetailsElement>("#m-1 > details")?.hasAttribute("open")).toBe(true);
    unmount();
    render(<SessionView api={{ ...api, fetchEvents: fetchEvents({ ...session, status: "ended" }) }} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByRole("button", { name: /@cli-routines/ })).toBeNull();
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
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("s1", "r2", { decision: "allow" }));
  });

  it("shows an open question as a form, sends the answers, and shows the answer in the stream once it is resolved", async () => {
    const question = { key: "Pick", question: "Pick", multiSelect: false, isOther: true, isSecret: false, options: [{ label: "A" }, { label: "B" }] };
    const open = [{ seq: 1, source_id: "a", kind: "permission_request" as const, payload: { requestId: "q1", kind: "question" as const, name: "AskUserQuestion", questions: [question] }, created_at: "2026-10-27T10:00:00Z" }];
    const decideApproval = mock(async () => ({ ok: true as const }));
    const view = render(<SessionView api={{ ...api, decideApproval, fetchEvents: async () => ({ viewer, session, events: open, inputs: [] }) }} sessionId="s1" />);
    await screen.findByRole("group", { name: "Question from Claude" });
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("s1", "q1", { decision: "allow", answers: { "0": "B" } }));
    view.unmount();

    const resolved = [...open, { seq: 2, source_id: "b", kind: "permission_resolved" as const, payload: { requestId: "q1", reason: "decided", decision: "allow" as const, by_name: "Dev", answers: { Pick: "B" } }, created_at: "2026-10-27T10:01:00Z" }];
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session, events: resolved, inputs: [] }) }} sessionId="s1" />);
    await screen.findByText(/Answered by Dev/);
    expect(screen.queryByRole("group", { name: "Question from Claude" })).toBeNull();
    expect(screen.getByText("B")).toBeTruthy();
  });

  describe("a prompt in the terminal with no card", () => {
    const blocked = { id: "i1", author_user_id: "u9", author_name: "Dev", text: "go on", state: "queued" as const, reason: "dialog", created_at: "2026-10-27T00:00:00Z", updated_at: "", mine: true };
    const ownerSession = { ...session, mine: true };
    const setup = (live: LiveSession = ownerSession) => {
      const stop = mock(async (..._args: unknown[]) => ({ withdrawn: [] as string[] }));
      render(<SessionView api={{ ...api, stop, fetchEvents: async () => ({ viewer, session: live, events: [], inputs: [blocked] }) }} sessionId="s1" />);
      return stop;
    };

    it("is dismissed by the owner's button or Esc, and the queued message stays", async () => {
      const stop = setup();
      fireEvent.click(await screen.findByRole("button", { name: /Dismiss in terminal/ }));
      await waitFor(() => expect(stop).toHaveBeenCalledWith("s1", { keepQueued: true }));
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    });

    it("is not offered to someone who does not own the session", async () => {
      setup({ ...session, mine: false });
      await screen.findByText("go on");
      expect(screen.queryByRole("button", { name: /Dismiss in terminal/ })).toBeNull();
    });
  });

  it("shows a Codex question as Codex's, with no terminal hint", async () => {
    const codex: LiveSession = { ...session, harness: "codex" };
    const question = { key: "area", question: "Which area?", multiSelect: false, isOther: false, isSecret: false, options: [{ label: "Auth" }] };
    const open = [{ seq: 1, source_id: "a", kind: "permission_request" as const, payload: { requestId: "q1", kind: "question" as const, name: "request_user_input", questions: [question] }, created_at: "2026-10-27T10:00:00Z" }];
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: codex, events: open, inputs: [] }) }} sessionId="s1" />);
    await screen.findByRole("group", { name: "Question from Codex" });
    expect(screen.queryByText(/answer in the terminal/)).toBeNull();
  });

  describe("an open question", () => {
    const question = { key: "Pick", question: "Pick", multiSelect: false, isOther: true, isSecret: false, options: [{ label: "A" }, { label: "B" }] };
    const open = [{ seq: 1, source_id: "a", kind: "permission_request" as const, payload: { requestId: "q1", kind: "question" as const, name: "AskUserQuestion", questions: [question] }, created_at: "2026-10-27T10:00:00Z" }];
    const setup = () => {
      const decideApproval = mock(async (..._args: unknown[]) => ({ ok: true as const }));
      const sendMessage = mock(async (..._args: unknown[]) => {});
      render(<SessionView api={{ ...api, decideApproval, sendMessage, fetchEvents: async () => ({ viewer, session, events: open, inputs: [] }) }} sessionId="s1" />);
      return { decideApproval, sendMessage };
    };

    it("is skipped by Esc, like the terminal", async () => {
      const { decideApproval } = setup();
      await screen.findByRole("group", { name: "Question from Claude" });
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("s1", "q1", { decision: "deny", message: "The user skipped this." }));
    });

    it("returns focus to the message box when its card is gone", async () => {
      let events: LiveSessionEvent[] = open;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderUi(
        <QueryClientProvider client={client}>
          <SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session, events, inputs: [] }) }} sessionId="s1" />
        </QueryClientProvider>,
      );
      fireEvent.click(await screen.findByRole("radio", { name: "Other" }));
      (screen.getByLabelText(/Your answer to/) as HTMLElement).focus();
      events = [...open, { seq: 2, source_id: "b", kind: "permission_resolved" as const, payload: { requestId: "q1", reason: "decided", decision: "allow" as const }, created_at: "2026-10-27T10:01:00Z" }];
      void client.invalidateQueries();
      await new Promise((r) => setTimeout(r, 1500));
      await waitFor(() => expect(screen.queryByRole("group", { name: "Question from Claude" })).toBeNull(), { timeout: 4000 });
      await waitFor(() => expect(document.activeElement?.id).toBe("session-message"), { timeout: 4000 });
    }, 15_000);

    it("is skipped by its Skip button", async () => {
      const { decideApproval } = setup();
      fireEvent.click(await screen.findByRole("button", { name: /^Skip/ }));
      await waitFor(() => expect(decideApproval).toHaveBeenCalledWith("s1", "q1", { decision: "deny", message: "The user skipped this." }));
    });

    it("is skipped when a message is sent from the message box, and the message is sent after", async () => {
      const { decideApproval, sendMessage } = setup();
      await screen.findByRole("group", { name: "Question from Claude" });
      fireEvent.change(screen.getByPlaceholderText(/Message/), { target: { value: "do this instead" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("s1", "do this instead"));
      expect(decideApproval).toHaveBeenCalledWith("s1", "q1", { decision: "deny", message: "The user skipped this." });
    });

    it("keeps Esc in an empty message box for the question, not for Stop", async () => {
      const stop = mock(async () => ({ withdrawn: [] }));
      render(<SessionView api={{ ...api, stop, fetchEvents: async () => ({ viewer, session, events: open, inputs: [] }) }} sessionId="s1" />);
      await screen.findByRole("group", { name: "Question from Claude" });
      fireEvent.keyDown(screen.getByPlaceholderText(/Message/), { key: "Escape" });
      expect(stop).not.toHaveBeenCalled();
    });
  });

  it("lets the owner delete from the header menu, after a dialog", async () => {
    const deleteSession = mock(async (_id: string) => {});
    const onDeleted = mock((_id: string) => {});
    const mine = { ...session, mine: true };
    render(<SessionView api={{ ...api, deleteSession, fetchEvents: async () => ({ viewer, session: mine, events: [], inputs: [] }) }} sessionId="s1" onDeleted={onDeleted} menuItems={() => [{ label: "Open in Terminal", onSelect: () => {} }]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Session options" }));
    const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(labels).toEqual(["Open in Terminal", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("s1"));
    expect(deleteSession).toHaveBeenCalledWith("s1");
  });

  it("offers no Delete on a session the viewer does not own", async () => {
    render(<SessionView api={{ ...api, deleteSession: async () => {} }} sessionId="s1" />);
    await screen.findByText(/Hi there/);
    expect(screen.queryByRole("button", { name: "Session options" })).toBeNull();
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

  describe("scroll follow", () => {
    const scroller = () => document.querySelector<HTMLElement>(".ui-session__scroll") as HTMLElement;
    const moveTo = (top: number) => {
      scroller().scrollTop = top;
      scroller().dispatchEvent(new Event("scroll"));
    };
    const jumpButton = () => screen.queryByRole("button", { name: "Jump to latest message" });

    it("shows Jump to latest once the reader scrolls up, and pressing it returns to the bottom", async () => {
      const restore = fakeScrollGeometry();
      const matchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
      try {
        render(<SessionView api={api} sessionId="s-jump" />);
        await screen.findByRole("heading", { name: "fix login" });
        expect(jumpButton()).toBeNull();
        moveTo(900);
        moveTo(400);
        fireEvent.click(await screen.findByRole("button", { name: "Jump to latest message" }));
        await waitFor(() => expect(scroller().scrollTop).toBe(899));
        await waitFor(() => expect(jumpButton()).toBeNull());
      } finally {
        window.matchMedia = matchMedia;
        restore();
      }
    });

    it("returns to a session at the reader's saved position, not the bottom", async () => {
      const restore = fakeScrollGeometry();
      try {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const first = render(<SessionView api={api} sessionId="s-memory" />, client);
        await screen.findByRole("heading", { name: "fix login" });
        moveTo(900);
        moveTo(400);
        await screen.findByRole("button", { name: "Jump to latest message" });
        first.unmount();

        render(<SessionView api={api} sessionId="s-memory" />, client);
        await screen.findByRole("heading", { name: "fix login" });
        expect(scroller().scrollTop).toBe(400);
        expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeTruthy();
      } finally {
        restore();
      }
    });

    it("treats a reader moved to a linked message as not at the bottom", async () => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function () {};
      try {
        render(<SessionView api={api} sessionId="s-linked" focusSeq={1} />);
        await screen.findByRole("heading", { name: "fix login" });
        expect(await screen.findByRole("button", { name: "Jump to latest message" })).toBeTruthy();
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });
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
    expect(await screen.findByText("Maya's computer is offline. Messages wait until it is back.")).toBeTruthy();
    expect(screen.getByText("Queued, Maya's computer is offline")).toBeTruthy();
    expect(screen.getByText(/· Host offline/)).toBeTruthy();
  });

  it("warns about a Claude version outside the tested range", async () => {
    const old: LiveSession = { ...session, harness_version: "2.2.0" };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: old, events: [], inputs: [] }) }} sessionId="s1" devOnly />);
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

describe("SessionView header", () => {
  it("shows the folder name next to the owner, with no connection text", async () => {
    render(<SessionView api={api} sessionId="s1" />);
    const header = (await screen.findByRole("heading", { name: /fix login/ })).closest("header")!;
    expect(within(header).getByText("marigold")).toBeTruthy();
    expect(screen.queryByText(/Reconnecting|Offline/)).toBeNull();
  });
});

describe("SessionView model and effort picker", () => {
  const mine: LiveSession = { ...session, mine: true, harness: "codex", model: "gpt-6-sol", reasoning_effort: "high" };
  const apiFor = (row: LiveSession, setMode: LiveSessionsApi["setMode"] = async () => {}): LiveSessionsApi => ({ ...api, setMode, fetchEvents: async () => ({ viewer, session: row, events: [], inputs: [] }) });

  it("shows the owner the model and effort next to Send, and asks the host when an effort is chosen", async () => {
    const setMode = mock(async (_id: string, _change: object) => {});
    render(<SessionView api={apiFor(mine, setMode)} sessionId="s1" />);
    const trigger = await screen.findByRole("button", { name: "Model and reasoning effort" });
    expect(trigger.textContent).toContain("GPT-6-Sol · High");
    fireEvent.click(trigger);
    expect(screen.queryByRole("group", { name: "Harnesses" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Extra high" }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("s1", { model: "gpt-6-sol", reasoningEffort: "xhigh" }));
    expect(screen.getByRole("button", { name: "Model and reasoning effort" }).textContent).toContain("Extra high");
  });

  it("sends the model with the effort that still fits it, and drops one the model does not offer", async () => {
    const setMode = mock(async (_id: string, _change: object) => {});
    render(<SessionView api={apiFor({ ...mine, reasoning_effort: "ultra" }, setMode)} sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Model and reasoning effort" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Luna" }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith("s1", { model: "gpt-6-luna", reasoningEffort: "medium" }));
  });

  it("shows nothing to a teammate, and nothing once the session has ended", async () => {
    const { unmount } = render(<SessionView api={apiFor({ ...mine, mine: false })} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByRole("button", { name: "Model and reasoning effort" })).toBeNull();
    unmount();
    render(<SessionView api={apiFor({ ...mine, status: "ended" })} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByRole("button", { name: "Model and reasoning effort" })).toBeNull();
  });

  it("names what Default means on this computer when the app says", async () => {
    const defaults = async () => ({ modelLabel: "Sonnet 5.5", effort: "low" });
    render(<SessionView api={apiFor({ ...mine, harness: "claude", model: null, reasoning_effort: null })} agentDefaults={defaults} sessionId="s1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Model and reasoning effort" }).textContent).toContain("Sonnet 5.5 · Low"));
  });
});

describe("SessionView agent label", () => {
  it("shows the effort next to the model", async () => {
    const withEffort: LiveSession = { ...session, harness: "codex", model: "gpt-6-luna", reasoning_effort: "xhigh" };
    render(<SessionView api={{ ...api, fetchEvents: async () => ({ viewer, session: withEffort, events: [], inputs: [] }) }} sessionId="s1" />);
    expect(await screen.findByText("Codex · GPT-6-Luna · Extra high")).toBeTruthy();
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

  it("reports an ended routine result once without counting a multiplayer view", async () => {
    const track = mock((_event: string, _props: unknown) => {});
    const endedApi: LiveSessionsApi = { ...routineApi, fetchEvents: async () => ({ viewer, session: { ...routineSession, status: "ended" }, events: [], inputs: [] }) };
    render(<SessionView api={endedApi} sessionId="s1" track={track as never} />);
    await screen.findByRole("heading", { name: "Weekly digest" });
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]).toEqual(["routine_result_viewed", { live_session_id: "s1" }]);
  });

  it("does not report a routine run, even when the page passes a tracker", async () => {
    const track = mock((_event: string, _props: unknown) => {});
    render(<SessionView api={routineApi} sessionId="s1" track={track as never} />);
    await screen.findByRole("heading", { name: "Weekly digest" });
    expect(track).not.toHaveBeenCalled();
  });

  describe("the mode menu", () => {
    const live = (extra: Partial<LiveSession> = {}): LiveSession => ({ ...session, mine: false, ...extra });
    const setup = (extra: Partial<LiveSession> = {}) => {
      const setMode = mock(async (..._args: unknown[]) => {});
      render(<SessionView api={{ ...api, setMode, fetchEvents: async () => ({ viewer, session: live(extra), events: [], inputs: [] }) }} sessionId="s1" />);
      return setMode;
    };

    it("shows Claude's current mode and the four choices in Shift+Tab order, and asks for the chosen one", async () => {
      const setMode = setup({ permission_mode: "auto" });
      fireEvent.click(await screen.findByRole("button", { name: "Mode: Auto" }));
      expect(screen.getAllByRole("menuitemradio").map((m) => m.querySelector(".ui-mode__name")?.textContent)).toEqual(["Manual", "Auto", "Accept edits", "Plan"]);
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));
      await waitFor(() => expect(setMode).toHaveBeenCalledWith("s1", { permissionMode: "plan" }));
      expect((await screen.findByRole("button", { name: /Mode: Plan/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows no mode until the host reports one", async () => {
      setup({ permission_mode: null });
      await screen.findByPlaceholderText(/Message/);
      expect(screen.queryByRole("button", { name: /Mode/ })).toBeNull();
    });

    it("cycles to the next mode on Shift+Tab in the message box", async () => {
      const setMode = setup({ permission_mode: "plan" });
      await screen.findByRole("button", { name: "Mode: Plan" });
      fireEvent.keyDown(screen.getByPlaceholderText(/Message/), { key: "Tab", shiftKey: true });
      await waitFor(() => expect(setMode).toHaveBeenCalledWith("s1", { permissionMode: "default" }));
    });

    it("shows a mode the menu does not list, without letting it be changed", async () => {
      setup({ permission_mode: "bypassPermissions" });
      const trigger = (await screen.findByRole("button", { name: /Mode: Bypass Permissions/ })) as HTMLButtonElement;
      expect(trigger.disabled).toBe(true);
    });

    it("gives Codex a mode menu and an approvals menu", async () => {
      const setMode = setup({ harness: "codex", permission_mode: "default", approval_mode: "ask-for-approval" });
      await screen.findByRole("button", { name: "Mode: Default" });
      fireEvent.click(screen.getByRole("button", { name: "Approvals: Ask for approval" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Full access/ }));
      await waitFor(() => expect(setMode).toHaveBeenCalledWith("s1", { approvalMode: "full-access" }));
    });

    it("shows a failed change beside the menu, not in the page banner", async () => {
      const setMode = mock(async (..._args: unknown[]) => { throw new Error("nope"); });
      const { container } = render(<SessionView api={{ ...api, setMode, fetchEvents: async () => ({ viewer, session: live({ permission_mode: "auto" }), events: [], inputs: [] }) }} sessionId="s1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Mode: Auto" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));
      const alert = await screen.findByText("Could not change the mode. Try again.");
      expect(alert.closest(".ui-composer__modes")).toBeTruthy();
      expect(container.querySelector(".ui-session__notice")).toBeNull();
      expect((screen.getByRole("button", { name: "Mode: Auto" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("is hidden once the session has ended, and for a routine run", async () => {
      setup({ status: "ended" });
      await screen.findByText(/This session has ended/);
      expect(screen.queryByRole("button", { name: /Mode:/ })).toBeNull();
    });
  });
});

describe("SessionView live text", () => {
  it("shows the text being written after the stored items, and shows it once when the stored message arrives", async () => {
    let page: LiveSessionEvent[] = [
      { seq: 1, source_id: "a", kind: "user_message", payload: { text: "hello" }, created_at: "" },
      { seq: 2, source_id: "b", kind: "assistant_text", payload: { text: "Hi there" }, created_at: "" },
    ];
    let emit: (chunk: LiveTextChunk) => void = () => {};
    let signal: (event: string) => void = () => {};
    const live: LiveSessionsApi = {
      ...api,
      fetchEvents: async () => ({ viewer, session, events: page, inputs: [] }),
      watchSignals: (_topic, onSignal) => ((signal = onSignal), () => {}),
      watchLiveText: (_sessionId, onChunk) => ((emit = onChunk), () => {}),
    };
    const { container } = render(<SessionView api={live} sessionId="s1" />);
    await screen.findByText("Hi there");
    act(() => emit({ messageId: "m1", index: 0, text: "Let me check", final: false }));
    const texts = () => Array.from(container.querySelectorAll(".ui-stream__item--assistant .ui-prose"), (prose) => prose.textContent?.trim());
    expect(texts()).toEqual(["Hi there", "Let me check"]);

    page = [...page, { seq: 3, source_id: "c", kind: "assistant_text", payload: { text: "Let me check" }, created_at: "" }];
    act(() => signal("events"));
    await waitFor(() => expect(container.querySelector(`#${messageDomId(3)}`)).not.toBeNull());
    await waitFor(() => expect(texts()).toEqual(["Hi there", "Let me check"]));
    expect(container.querySelectorAll(`#${messageDomId(3)}`).length).toBe(1);
  });
});

const nestedEvents: LiveSessionEvent[] = [
  { seq: 1, source_id: "spawn", kind: "tool_use", payload: { name: "Agent", tool_use_id: "spawn", input: { name: "worker", description: "Inspect files" } }, created_at: "" },
  { seq: 2, source_id: "spawn-result", kind: "tool_result", payload: { tool_use_id: "spawn", content: "agentId: worker-1" }, created_at: "" },
  { seq: 3, source_id: "tool", kind: "tool_use", payload: { agent_id: "worker-1", name: "Bash", tool_use_id: "tool", input: { command: "ls" } }, created_at: "" },
  { seq: 4, source_id: "result", kind: "tool_result", payload: { agent_id: "worker-1", tool_use_id: "tool", content: "private tool output" }, created_at: "" },
];

it("reveals a linked nested tool before scrolling to it", async () => {
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  try {
    const nestedApi = { ...api, fetchEvents: async () => ({ session: { ...session, last_seq: 4 }, viewer, inputs: [], events: nestedEvents }) };
    const { container } = render(<SessionView api={nestedApi} sessionId="linked-nested" focusSeq={3} />);
    await waitFor(() => expect(scrolled).toEqual(["m-3"]));
    expect(container.querySelector("#m-1 > details")?.hasAttribute("open")).toBe(true);
    expect(container.querySelector("#m-3 > details")?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("private tool output")).toBeTruthy();
  } finally { Element.prototype.scrollIntoView = original; }
});

it("restores expanded subagent work on a cached A to B to A switch", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const nestedApi = { ...api, fetchEvents: async (id: string, after: number) => ({ session: { ...session, id, last_seq: id === "a" ? 4 : 0 }, viewer, inputs: [], events: id === "a" ? nestedEvents.filter((e) => e.seq > after) : [] }) };
  const tree = (id: string) => <QueryClientProvider client={client}><SessionView key={id} api={nestedApi} sessionId={id} /></QueryClientProvider>;
  const { container, rerender } = renderUi(tree("a"));
  await screen.findByRole("heading", { name: "fix login" });
  const parent = container.querySelector<HTMLDetailsElement>("#m-1 > details")!;
  expect(parent.querySelector(".ui-stream__nested")).toBeNull();
  act(() => { parent.open = true; fireEvent(parent, new Event("toggle")); });
  const tool = container.querySelector<HTMLDetailsElement>("#m-3 > details")!;
  act(() => { tool.open = true; fireEvent(tool, new Event("toggle")); });
  expect(screen.getByText("private tool output")).toBeTruthy();
  rerender(tree("b"));
  await waitFor(() => expect(screen.queryByText("private tool output")).toBeNull());
  rerender(tree("a"));
  await screen.findByText("private tool output");
});

it("keeps a missing linked target pending until its events arrive", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scrolled: string[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  try {
    const emptyApi = { ...api, fetchEvents: async () => ({ session: { ...session, last_seq: 0 }, viewer, inputs: [], events: [] }) };
    render(<SessionView api={emptyApi} sessionId="late-target" focusSeq={3} />, client);
    await screen.findByRole("heading", { name: "fix login" });
    expect(scrolled).toEqual([]);
    act(() => { client.setQueryData(["live-session", "late-target"], { session: { ...session, last_seq: 4 }, viewer, events: nestedEvents, inputs: [] }); });
    await waitFor(() => expect(scrolled).toEqual(["m-3"]));
    expect(screen.getByText("private tool output")).toBeTruthy();
  } finally { Element.prototype.scrollIntoView = original; }
});

describe("SessionView for a cloud session", () => {
  const cloud = (extra: Partial<LiveSession> = {}): LiveSession => ({ ...session, runtime: "cloud", host_name: "Draft Cloud", mine: true, ...extra });
  const withSession = (live: LiveSession, extra: Partial<LiveSessionsApi> = {}): LiveSessionsApi => ({ ...api, ...extra, fetchEvents: async () => ({ viewer, session: live, events: [], inputs: [] }) });
  const resume = mock(async (_id: string) => {});

  it("says it runs in Draft Cloud, with when its files were last backed up", async () => {
    const backedUp = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<SessionView api={withSession(cloud({ raw_uploaded_at: backedUp }))} sessionId="s1" />);
    expect(await screen.findByText("Draft Cloud · Last backed up 5m ago")).toBeTruthy();
  });

  it("says only that it runs in Draft Cloud before the first backup", async () => {
    render(<SessionView api={withSession(cloud({ raw_uploaded_at: null }))} sessionId="s1" />);
    expect(await screen.findByText("Draft Cloud")).toBeTruthy();
    expect(screen.queryByText(/Last backed up/)).toBeNull();
  });

  it("shows no cloud note for a computer session", async () => {
    render(<SessionView api={withSession({ ...session, mine: true, runtime: "local" })} sessionId="s1" />);
    await screen.findByRole("heading", { name: "fix login" });
    expect(screen.queryByText(/Draft Cloud/)).toBeNull();
  });

  it("names a waking session Waking up, and keeps Stop for it", async () => {
    render(<SessionView api={withSession(cloud({ status: "starting", last_seq: 9 }))} sessionId="s1" />);
    expect(await screen.findByText(/Waking up/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("never offers Resume for a cloud session, even one that ended on its own", async () => {
    render(<SessionView api={withSession(cloud({ status: "ended", end_reason: "exited" }), { resume })} sessionId="s1" />);
    await screen.findByText(/This session has ended/);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("hides Resume for a session that failed to start or expired", async () => {
    for (const end_reason of ["start_failed", "expired"]) {
      const view = render(<SessionView api={withSession({ ...session, status: "ended", mine: true, end_reason }, { resume })} sessionId="s1" />);
      await screen.findByText(/This session has ended/);
      expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
      view.unmount();
    }
  });

  it("keeps Resume for a computer session that exited", async () => {
    render(<SessionView api={withSession({ ...session, status: "ended", mine: true, end_reason: "exited" }, { resume })} sessionId="s1" />);
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
  });
});

describe("SessionView while a cloud session sleeps", () => {
  // last_seq matches the one event the fixtures return: the stream pages until it reaches last_seq.
  const sleeping: LiveSession = { ...session, status: "sleeping", runtime: "cloud", host_name: "Draft Cloud", mine: true, last_seq: 1 };
  const request = { seq: 1, source_id: "a", kind: "permission_request" as const, payload: { requestId: "r1", name: "Bash", input: { command: "ls" } }, created_at: "2026-10-27T10:00:00Z" };
  const sleepingApi = (events: LiveSessionEvent[] = [], extra: Partial<LiveSessionsApi> = {}): LiveSessionsApi => ({
    ...api,
    ...extra,
    fetchEvents: async () => ({ viewer, session: sleeping, events, inputs: [] }),
  });

  it("shows Sleeping, and a composer that wakes the session instead of saying the host is offline", async () => {
    render(<SessionView api={sleepingApi()} sessionId="s1" />);
    expect(await screen.findByText(/Sleeping/)).toBeTruthy();
    const box = screen.getByPlaceholderText("Send a message to wake this session.");
    expect(box).toBeTruthy();
    expect(screen.queryByText(/offline/)).toBeNull();
    expect(screen.queryByText(/not responding/)).toBeNull();
  });

  it("hides Stop, the mode menu and the model picker", async () => {
    render(<SessionView api={sleepingApi()} sessionId="s1" />);
    await screen.findByText(/Sleeping/);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mode:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Model and reasoning effort" })).toBeNull();
  });

  it("disables the approve buttons and says it is waking the session to ask again", async () => {
    const decideApproval = mock(async () => ({ ok: true as const }));
    render(<SessionView api={sleepingApi([request], { decideApproval })} sessionId="s1" />);
    expect(await screen.findByText("Waking the session to ask again")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^Deny/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("keeps the approve buttons for a session that is awake", async () => {
    render(<SessionView api={{ ...sleepingApi([request]), fetchEvents: async () => ({ viewer, session: { ...sleeping, status: "live" }, events: [request], inputs: [] }) }} sessionId="s1" />);
    const allow = (await screen.findByRole("button", { name: "Allow" })) as HTMLButtonElement;
    expect(allow.disabled).toBe(false);
    expect(screen.queryByText("Waking the session to ask again")).toBeNull();
  });
});

it("keeps resume pending across an early live signal until confirmation", async () => {
  let current: LiveSession = { ...session, status: "ended", mine: true, end_reason: "exited" };
  let finish!: () => void;
  let signal = (_event: string) => {};
  const resume = mock(() => new Promise<void>(resolve => { finish = resolve; }));
  const fetchEvents = mock(async () => ({ viewer, session: current, events: [], inputs: [] }));
  render(<SessionView api={{ ...api, resume, fetchEvents, watchSignals: (_topic, listener) => { signal = listener; return () => {}; } }} sessionId="s1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  expect((screen.getByRole("button", { name: "Resuming…" }) as HTMLButtonElement).disabled).toBe(true);
  current = { ...current, status: "live" };
  const calls = fetchEvents.mock.calls.length;
  act(() => signal("events"));
  await waitFor(() => expect(fetchEvents.mock.calls.length).toBeGreaterThan(calls));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByRole("button", { name: "Resuming…" })).toBeTruthy();
  await act(async () => finish());
  await screen.findByRole("textbox");
  expect(resume).toHaveBeenCalledTimes(1);
});

it("restores a saved failure with Retry and preserves an unsent draft", async () => {
  let current: LiveSession = { ...session, mine: true };
  let signal = (_event: string) => {};
  const fetchEvents = mock(async () => ({ viewer, session: current, events: [], inputs: [] }));
  const live = { ...api, resume: async () => {}, fetchEvents, watchSignals: (_topic: string, listener: (event: string) => void) => { signal = listener; return () => {}; } };
  const view = render(<SessionView api={live} sessionId="s1" />);
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "keep this draft" } });
  current = { ...current, status: "ended", end_reason: "host_exited", last_failure: { id: "f1", requestId: "r1", code: "host_exited", at: new Date().toISOString(), message: "The agent disconnected unexpectedly.", retryable: true } };
  act(() => signal("events"));
  expect((await screen.findByRole("alert")).textContent).toContain("disconnected unexpectedly");
  expect(screen.getByRole("button", { name: "Retry resume" })).toBeTruthy();
  view.unmount();
  render(<SessionView api={live} sessionId="s1" />);
  await screen.findByRole("alert");
  current = { ...current, status: "live", last_failure: null };
  act(() => signal("events"));
  expect((await screen.findByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this draft");
});
