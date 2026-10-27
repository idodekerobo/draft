import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EVENTS_PAGE_SIZE } from "draft-core/live-sessions";
import { Suspense } from "react";
import { useSessionStream } from "./useSessionStream";
import type { LiveSession, LiveSessionEvent, LiveSessionsApi } from "./types";

afterEach(cleanup);

const session: LiveSession = {
  id: "s1", owner_user_id: "u1", owner_name: "Maya", title: "t", folder_name: "f", host_name: null, status: "live",
  started_at: "2026-10-27T00:00:00Z", ended_at: null, last_event_at: null, last_seq: 0,
};
const event = (seq: number): LiveSessionEvent => ({ seq, source_id: `s${seq}`, kind: "assistant_text", payload: { text: `m${seq}` }, created_at: "" });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => event(from + i));

function setup(pages: (after: number) => LiveSessionEvent[]) {
  const afters: number[] = [];
  const fetchEvents = mock(async (_id: string, after: number) => {
    afters.push(after);
    return { session, events: pages(after), inputs: [] };
  });
  const api = { fetchEvents } as unknown as LiveSessionsApi;
  let renders = 0;
  function Probe() {
    const stream = useSessionStream(api, "s1");
    renders++;
    return (
      <div>
        <span data-testid="count">{stream.events.length}</span>
        <button type="button" onClick={() => void stream.refresh()}>refresh</button>
      </div>
    );
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Suspense fallback={<span>loading</span>}>
        <Probe />
      </Suspense>
    </QueryClientProvider>,
  );
  return { afters, renders: () => renders };
}

describe("useSessionStream", () => {
  it("shows the fallback until the first page, then asks only for events above the last one it has", async () => {
    let available = 2;
    const t = setup((after) => range(1, available).filter((e) => e.seq > after));
    expect(screen.getByText("loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));

    available = 3;
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"));
    expect(t.afters).toEqual([0, 2]);
  });

  it("follows a full page at once with the next one", async () => {
    const t = setup((after) => (after === 0 ? range(1, EVENTS_PAGE_SIZE) : range(EVENTS_PAGE_SIZE + 1, EVENTS_PAGE_SIZE + 5)));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe(String(EVENTS_PAGE_SIZE + 5)));
    expect(t.afters).toEqual([0, EVENTS_PAGE_SIZE]);
  });

  it("does not render again when a poll finds nothing new", async () => {
    const t = setup((after) => range(1, 2).filter((e) => e.seq > after));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    const before = t.renders();
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() => expect(t.afters.length).toBe(2));
    await new Promise((done) => setTimeout(done, 30));
    expect(t.renders()).toBe(before);
  });
});
