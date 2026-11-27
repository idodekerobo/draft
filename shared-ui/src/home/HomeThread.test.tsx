import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { queryKeys } from "../query/keys";
import type { LiveSession, LiveSessionEvent, LiveSessionsApi } from "../live-sessions/types";
import { HomeView } from "./HomeView";
import { HomeThread, type HomeThreadApi } from "./HomeThread";
import type { NeedsYou, NeedsYouRow } from "./types";

afterEach(() => {
  cleanup();
  mock.restore();
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

const WELCOME: LiveSessionEvent = { seq: 1, source_id: "welcome", kind: "assistant_text", payload: { text: "Hi, I'm Draft." }, created_at: "" };
const session: LiveSession = { id: "home-1", owner_user_id: "u1", owner_name: "Maya", title: null, folder_name: null, host_name: null, status: "live", started_at: "2026-11-26T00:00:00Z", ended_at: null, last_event_at: null, last_seq: 1, mine: true, harness: "pi", execution_target: "backend" } as LiveSession;
const viewer = { id: "u1", name: "Maya" };

function liveApi(overrides: Partial<LiveSessionsApi> & { events?: LiveSessionEvent[]; last_seq?: number } = {}): LiveSessionsApi {
  const { events = [WELCOME], last_seq = 1, ...rest } = overrides;
  return {
    listSessions: async () => [session],
    fetchEvents: async () => ({ viewer, session: { ...session, last_seq }, events, inputs: [] }),
    sendMessage: mock(async () => {}),
    actOnInput: async () => {},
    decideApproval: async () => ({ ok: true }),
    stop: async () => ({ withdrawn: [] }),
    setMode: mock(async () => {}),
    ...rest,
  };
}

const threadApi = (overrides: Partial<HomeThreadApi> = {}): HomeThreadApi => ({
  loadSession: async () => ({ id: "home-1", model: "claude-sonnet-5-5", canReply: true }),
  loadModels: async () => [{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { id: "claude-fable-5-2", name: "Claude Fable 5.2" }],
  ...overrides,
});

const render = (ui: ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  renderUi(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

describe("Draft's thread on Home", () => {
  it("shows the shape of the thread while the session loads, then the welcome and three prompts to someone who has not spoken", async () => {
    render(<HomeThread workspaceId="ws-1" api={liveApi()} thread={threadApi()} onOpenConnections={() => {}} />);
    expect(screen.getByRole("status", { name: "Loading your conversation with Draft" })).toBeTruthy();
    await screen.findByText("Hi, I'm Draft.");
    expect(screen.getAllByRole("button").filter((b) => b.classList.contains("ui-session__suggestion"))).toHaveLength(3);
  });

  it("sends a suggested prompt when it is chosen", async () => {
    const api = liveApi();
    render(<HomeThread workspaceId="ws-1" api={api} thread={threadApi()} onOpenConnections={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "What needs me right now?" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith("home-1", "What needs me right now?"));
  });

  it("stops offering prompts once the person has said something", async () => {
    const events: LiveSessionEvent[] = [WELCOME, { seq: 2, source_id: "u", kind: "user_message", payload: { text: "hello" }, created_at: "" }];
    const { container } = render(<HomeThread workspaceId="ws-1" api={liveApi({ events, last_seq: 2 })} thread={threadApi()} onOpenConnections={() => {}} />);
    await screen.findByText("Hi, I'm Draft.");
    expect(container.querySelector(".ui-session__suggestions")).toBeNull();
  });

  it("says Draft can't reply right now when the workspace has no usable login, and Reconnect opens Connections", async () => {
    const onOpenConnections = mock(() => {});
    render(<HomeThread workspaceId="ws-1" api={liveApi()} thread={threadApi({ loadSession: async () => ({ id: "home-1", model: null, canReply: false }) })} onOpenConnections={onOpenConnections} />);
    await screen.findByText(/Draft can't reply right now/);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onOpenConnections).toHaveBeenCalled();
  });

  it("says Draft can't reply when the session cannot start, and tries again on request", async () => {
    let attempts = 0;
    const loadSession = async () => {
      if (++attempts === 1) throw new Error("down");
      return { id: "home-1", model: null, canReply: true };
    };
    render(<HomeThread workspaceId="ws-1" api={liveApi()} thread={threadApi({ loadSession })} onOpenConnections={() => {}} />);
    await screen.findByText(/Draft can't reply right now/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Hi, I'm Draft.");
  });

  it("offers every model of the lab in the session's own picker, and a change goes to the session as a model change", async () => {
    const api = liveApi();
    render(<HomeThread workspaceId="ws-1" api={api} thread={threadApi()} onOpenConnections={() => {}} />);
    const trigger = await screen.findByRole("button", { name: "Model" });
    expect(trigger.textContent).toContain("Claude Sonnet 5.5");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Claude Sonnet 5.5✓", "Claude Fable 5.2"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Fable 5.2/ }));
    await waitFor(() => expect(api.setMode).toHaveBeenCalledWith("home-1", { model: "claude-fable-5-2" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Fable 5.2"));
  });

  it("keeps the earlier model and says so when the change cannot be saved", async () => {
    const api = liveApi({ setMode: async () => { throw new Error("no"); } });
    render(<HomeThread workspaceId="ws-1" api={api} thread={threadApi()} onOpenConnections={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Fable 5.2/ }));
    await screen.findByText("Could not change the model. Try again.");
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Sonnet 5.5");
  });

  it("shows Stop beside Send only while Draft is working, and not in the header", async () => {
    const stop = mock(async () => ({ withdrawn: [] }));
    const { container } = render(<HomeThread workspaceId="ws-1" api={liveApi({ stop })} thread={threadApi()} onOpenConnections={() => {}} />);
    await screen.findByText("Hi, I'm Draft.");
    expect(container.querySelector(".ui-session__header--home button")).toBeNull();
    const button = await screen.findByRole("button", { name: "Stop" });
    expect(button.closest(".ui-composer__footer")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it("shows the thread at once when the person comes back, from what was loaded before", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = liveApi();
    const first = render(<HomeThread workspaceId="ws-1" api={api} thread={threadApi()} onOpenConnections={() => {}} />, client);
    await screen.findByText("Hi, I'm Draft.");
    first.unmount();
    const slow = threadApi({ loadSession: () => new Promise(() => {}) });
    render(<HomeThread workspaceId="ws-1" api={api} thread={slow} onOpenConnections={() => {}} />, client);
    expect(screen.queryByRole("status", { name: /Loading your conversation/ })).toBeNull();
    await screen.findByText("Hi, I'm Draft.");
  });
});

const todo = (n: number): NeedsYouRow => ({
  kind: "notification", id: `n${n}`, createdAt: `2026-11-2${n}T10:00:00Z`,
  notification: { id: `n${n}`, kind: "todo_routed", subject: `Task ${n}`, text: "", link: null, needsAction: true, state: "open", refType: null, refId: null, createdAt: `2026-11-2${n}T10:00:00Z`, actedAt: null },
});
const approval = (sessionId: string): NeedsYouRow => ({ kind: "approval", id: sessionId, sessionId, title: "Draft", openCount: 1, createdAt: "2026-11-26T10:00:00Z" } as NeedsYouRow);

function renderHome(initial: NeedsYou, options: { live?: LiveSessionsApi; thread?: HomeThreadApi } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let current = initial;
  const nav = { onOpenSession: mock(() => {}), onOpenRun: mock(() => {}), onOpenConnections: mock(() => {}), onOpenRoutines: mock(() => {}) };
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={{ getNeedsYou: async () => current } as DraftApi}>
        <HomeView workspaceId="ws-1" {...nav} thread={{ api: options.live ?? liveApi(), home: options.thread ?? threadApi() }} />
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  return { nav, client, set: (next: NeedsYou) => { current = next; return client.invalidateQueries({ queryKey: queryKeys.needsYou("ws-1") }); } };
}

describe("Home with Draft's thread", () => {
  it("has a tab list for phones that moves with the arrow keys and keeps one tab in the tab order", async () => {
    renderHome({ count: 0, rows: [] });
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Needs you", "Chat"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("shows a dot on Chat when Draft writes while the person is on Needs you, and clears it on opening Chat", async () => {
    let seq = 1;
    const live = liveApi();
    live.fetchEvents = async () => ({ viewer, session: { ...session, last_seq: seq }, events: seq > 1 ? [WELCOME, { seq, source_id: "r", kind: "assistant_text", payload: { text: "Done." }, created_at: "" }] : [WELCOME], inputs: [] });
    const { client } = renderHome({ count: 0, rows: [] }, { live });
    const chat = (await screen.findAllByRole("tab"))[1]!;
    await screen.findByText("Hi, I'm Draft.");
    expect(chat.querySelector(".ui-home__dot")).toBeNull();
    seq = 4;
    act(() => { void client.invalidateQueries(); });
    await waitFor(() => expect(chat.querySelector(".ui-home__dot")).not.toBeNull());
    fireEvent.click(chat);
    await waitFor(() => expect(chat.querySelector(".ui-home__dot")).toBeNull());
  });

  it("points a Draft question's row at the thread instead of another page", async () => {
    const { nav } = renderHome({ count: 1, rows: [approval("home-1")] });
    await screen.findByText("Hi, I'm Draft.");
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(nav.onOpenSession).not.toHaveBeenCalled();
    expect((await screen.findAllByRole("tab"))[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("still opens another session's approval on its own page", async () => {
    const { nav } = renderHome({ count: 1, rows: [approval("team-9")] });
    await screen.findByText("Hi, I'm Draft.");
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(nav.onOpenSession).toHaveBeenCalledWith("team-9");
  });
});

describe("what Draft changed on Needs you", () => {
  it("tags a row that appears after the first load as updated just now", async () => {
    const { set } = renderHome({ count: 1, rows: [todo(1)] });
    await screen.findByText("Task 1");
    expect(screen.queryByText("Updated just now")).toBeNull();
    await act(async () => { await set({ count: 2, rows: [todo(1), todo(2)] }); });
    await screen.findByText("Task 2");
    expect(screen.getAllByText("Updated just now")).toHaveLength(1);
  });

  it("holds the rows still while the pointer is over them, and brings them up to date when it leaves", async () => {
    const { set } = renderHome({ count: 2, rows: [todo(1), todo(2)] });
    const list = (await screen.findByText("Task 1")).closest("ul")!;
    fireEvent.pointerEnter(list);
    await act(async () => { await set({ count: 1, rows: [todo(2)] }); });
    expect(screen.getByText("Task 1")).toBeTruthy();
    fireEvent.pointerLeave(list);
    await waitFor(() => expect(screen.queryByText("Task 1")).toBeNull());
    expect(screen.getByText("Task 2")).toBeTruthy();
  });
});
