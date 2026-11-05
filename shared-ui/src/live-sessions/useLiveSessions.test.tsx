import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useLiveSessions } from "./sessions-list";
import type { LiveSession, LiveSessionsApi } from "./types";

afterEach(cleanup);

const session = (id: string): LiveSession => ({
  id, owner_user_id: "u1", owner_name: "Maya", title: id, folder_name: "f", host_name: null, status: "live",
  started_at: "2026-10-27T00:00:00Z", ended_at: null, last_event_at: null, last_seq: 0,
});

function setup(watchSignals?: LiveSessionsApi["watchSignals"]) {
  let rows = [session("a")];
  const listSessions = mock(async () => rows);
  const api = { listSessions, watchSignals } as unknown as LiveSessionsApi;
  function Probe() {
    const { sessions } = useLiveSessions(api, "w1");
    return <span data-testid="count">{sessions.length}</span>;
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Probe />
    </QueryClientProvider>,
  );
  return { listSessions, setRows: (next: LiveSession[]) => (rows = next) };
}

describe("useLiveSessions signals", () => {
  it("watches the workspace topic and reloads the list on a sessions signal", async () => {
    let send: (event: string) => void = () => {};
    const topics: string[] = [];
    const t = setup((topic, onSignal) => {
      topics.push(topic);
      send = onSignal;
      return () => {};
    });
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    expect(topics).toEqual(["signals:workspace:w1"]);

    t.setRows([session("a"), session("b")]);
    send("sessions");
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"), { timeout: 4000 });
  });

  it("ignores signals that do not change the list", async () => {
    let send: (event: string) => void = () => {};
    const t = setup((_topic, onSignal) => {
      send = onSignal;
      return () => {};
    });
    await waitFor(() => expect(t.listSessions).toHaveBeenCalledTimes(1));
    send("context");
    await new Promise((done) => setTimeout(done, 1800));
    expect(t.listSessions).toHaveBeenCalledTimes(1);
  });
});
