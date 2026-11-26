import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { toast } from "../toast";
import { HomeView } from "./HomeView";
import type { NeedsYou, NeedsYouRow } from "./types";

afterEach(() => { cleanup(); mock.restore(); try { window.localStorage.clear(); } catch { /* ignore */ } });

const todo = (n: number): NeedsYouRow => ({
  kind: "notification", id: `n${n}`, createdAt: `2026-11-2${n}T10:00:00Z`,
  notification: { id: `n${n}`, kind: "todo_routed", subject: `Task ${n}`, text: "", link: null, needsAction: true, state: "open", refType: null, refId: null, createdAt: `2026-11-2${n}T10:00:00Z`, actedAt: null },
});

function renderHome(needsYou: NeedsYou, api: Partial<DraftApi> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const nav = { onOpenSession: mock(() => {}), onOpenRun: mock(() => {}), onOpenConnections: mock(() => {}), onOpenRoutines: mock(() => {}) };
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={{ getNeedsYou: async () => needsYou, ...api } as DraftApi}>
        <HomeView workspaceId="ws-1" {...nav} />
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  return nav;
}

test("says so when nothing needs the person", async () => {
  renderHome({ count: 0, rows: [] });
  await screen.findByText("Nothing needs you right now.");
});

test("shows three rows and the rest behind a count", async () => {
  renderHome({ count: 5, rows: [1, 2, 3, 4, 5].map(todo) });
  await screen.findByText("Task 1");
  expect(screen.queryByText("Task 4")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "2 more" }));
  await screen.findByText("Task 5");
});

test("Done saves the action, then offers Undo in the toast and refetches", async () => {
  const success = spyOn(toast, "success").mockImplementation(() => 1);
  const actOnNotification = mock(async () => ({ ok: true as const, state: "done" as const, changed: true }));
  const getNeedsYou = mock(async () => ({ count: 1, rows: [todo(1)] }));
  renderHome({ count: 1, rows: [todo(1)] }, { actOnNotification, getNeedsYou });
  fireEvent.click(await screen.findByRole("button", { name: "Done: Task 1" }));
  await waitFor(() => expect(actOnNotification).toHaveBeenCalledWith("n1", "done"));
  await waitFor(() => expect(success).toHaveBeenCalled());
  const options = (success.mock.calls[0] as unknown as [string, { action: { label: string } }])[1];
  expect(options.action.label).toBe("Undo");
  await waitFor(() => expect(getNeedsYou.mock.calls.length).toBeGreaterThan(1));
  // The pressed button is gone, so focus must land on the heading and not on the page body.
  await waitFor(() => expect(document.activeElement?.id).toBe("needs-you-title"));
});

test("Not mine is offered only on to-dos, and a refusal is shown", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => 1);
  const actOnNotification = mock(async () => ({ ok: false as const, code: "already_acted", message: "Already handled." }));
  renderHome({ count: 1, rows: [todo(1)] }, { actOnNotification });
  fireEvent.click(await screen.findByRole("button", { name: "Not mine: Task 1" }));
  await waitFor(() => expect(error).toHaveBeenCalledWith("Already handled."));
});

test("a failed send has no Retry, and a broken connection links to Connections", async () => {
  const nav = renderHome({
    count: 2,
    rows: [
      { kind: "failed_delivery", id: "d1", notificationId: "n1", subject: "Weekly update", channel: "email", status: "failed", createdAt: "2026-11-24T10:00:00Z" },
      { kind: "connection_attention", id: "c1", provider: "gmail", status: "degraded", createdAt: "2026-11-23T10:00:00Z" },
    ],
  });
  await screen.findByText(/Email to someone failed/);
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(nav.onOpenConnections).toHaveBeenCalled();
});

test("hiding the panel is remembered on this device", async () => {
  renderHome({ count: 1, rows: [todo(1)] });
  await screen.findByText("Task 1");
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.queryByText("Task 1")).toBeNull();
  expect(window.localStorage.getItem("draft.home.needsYouCollapsed")).toBe("1");
});

test("an error shows a retry and keeps the page", async () => {
  renderHome({ count: 0, rows: [] }, { getNeedsYou: async () => { throw new Error("down"); } });
  await screen.findByText(/Couldn't load what needs you/);
});

test("an email link marks its row and keeps it visible past the cap", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={{ getNeedsYou: async () => ({ count: 5, rows: [1, 2, 3, 4, 5].map(todo) }) } as unknown as DraftApi}>
        <HomeView workspaceId="ws-1" onOpenSession={() => {}} onOpenRun={() => {}} onOpenConnections={() => {}} onOpenRoutines={() => {}} highlightId="n5" />
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  const row = (await screen.findByText("Task 5")).closest("li")!;
  expect(row.getAttribute("aria-current")).toBe("true");
});

test("a proposed teammate can be approved or rejected from Home", async () => {
  const decidePerson = mock(async () => ({ ok: true as const }));
  const row: NeedsYouRow = {
    kind: "notification", id: "p1", createdAt: "2026-11-25T10:00:00Z",
    notification: { id: "p1", kind: "identity_proposed", subject: "A teammate needs approval", text: "", link: null, needsAction: true, state: "open", refType: "person", refId: "person-9", createdAt: "2026-11-25T10:00:00Z", actedAt: null },
  };
  renderHome({ count: 1, rows: [row] }, { decidePerson });
  fireEvent.click(await screen.findByRole("button", { name: "Approve: A teammate needs approval" }));
  await waitFor(() => expect(decidePerson).toHaveBeenCalledWith("person-9", "approve"));
  expect(screen.queryByRole("button", { name: /Not mine/ })).toBeNull();
});

test("a stopped login shows Reconnect, not Done, and opens Connections", async () => {
  const row: NeedsYouRow = {
    kind: "notification", id: "c1", createdAt: "2026-11-25T10:00:00Z",
    notification: { id: "c1", kind: "connection_attention", subject: "Your Claude login stopped working", text: "Reconnect it so Home keeps working.", link: null, needsAction: true, state: "open", refType: "credential", refId: "cred-1", createdAt: "2026-11-25T10:00:00Z", actedAt: null },
  };
  const nav = renderHome({ count: 1, rows: [row] });
  await screen.findByText("Your Claude login stopped working");
  expect(screen.queryByRole("button", { name: /Done/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(nav.onOpenConnections).toHaveBeenCalled();
});

test("until the first to-do, a Get started checklist shows progress and links to the next step", async () => {
  const nav = renderHome({ count: 0, rows: [], getStarted: { meetingSource: true, routine: false, firstTodo: false } });
  await screen.findByText("Get started");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open routines" }));
  expect(nav.onOpenRoutines).toHaveBeenCalled();
});

test("the checklist goes away once the first to-do has arrived", async () => {
  renderHome({ count: 0, rows: [], getStarted: { meetingSource: true, routine: true, firstTodo: true } });
  await screen.findByText("Nothing needs you right now.");
  expect(screen.queryByText("Get started")).toBeNull();
});
