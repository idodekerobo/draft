import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { useSessionInputs } from "./useSessionInputs";
import { sessionStreamKey, type SessionStreamData } from "./useSessionStream";
import type { TrackFn } from "../analytics/events";
import type { LiveSessionInput, LiveSessionsApi } from "./types";

afterEach(cleanup);

const serverInput = (patch: Partial<LiveSessionInput> = {}): LiveSessionInput => ({
  id: "i1", author_user_id: "u1", author_name: "Priya", text: "run the tests", state: "queued", reason: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mine: true, ...patch,
});

function setup(sendMessage: LiveSessionsApi["sendMessage"], initial: LiveSessionInput[] = [], track?: TrackFn, mine?: boolean, refreshFn: () => Promise<void> = async () => {}) {
  let server = initial;
  const refresh = mock(refreshFn);
  const api = { sendMessage } as unknown as LiveSessionsApi;
  let latest!: ReturnType<typeof useSessionInputs>;
  function Probe() {
    const { data } = useQuery<SessionStreamData>({ queryKey: sessionStreamKey("s1"), queryFn: () => Promise.reject(new Error("unused")), enabled: false });
    latest = useSessionInputs(api, "s1", data?.inputs ?? server, refresh, track);
    return <span data-testid="states">{latest.inputs.map((i) => `${i.text}:${i.state}`).join("|")}</span>;
  }
  const client = new QueryClient();
  if (mine !== undefined) client.setQueryData(sessionStreamKey("s1"), { session: { id: "s1", mine }, inputs: [] } as unknown as SessionStreamData);
  const tree = () => (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    client,
    refresh,
    send: (text: string) => latest.send(text),
    setServer: (next: LiveSessionInput[]) => { server = next; view.rerender(tree()); },
  };
}

describe("useSessionInputs", () => {
  it("shows a send as Sending… at once and drops it when the send finishes", async () => {
    let finish = () => {};
    const t = setup(() => new Promise<void>((resolve) => { finish = resolve; }));
    let sent!: Promise<void>;
    act(() => { sent = t.send("hello"); });
    await waitFor(() => expect(screen.getByTestId("states").textContent).toBe("hello:sending"));
    await act(async () => { finish(); await sent; });
    await waitFor(() => expect(screen.getByTestId("states").textContent).toBe(""));
  });

  it("removes the Sending… item and rejects when the send fails", async () => {
    const t = setup(async () => { throw new Error("queue_full"); });
    let failure: unknown;
    await act(async () => { await t.send("hello").catch((e) => { failure = e; }); });
    expect((failure as Error).message).toBe("queue_full");
    expect(screen.getByTestId("states").textContent).toBe("");
  });

  it("shows one line, not two, when the server list already holds the message", async () => {
    let finish = () => {};
    const t = setup(() => new Promise<void>((resolve) => { finish = resolve; }));
    act(() => { void t.send("run the tests"); });
    await waitFor(() => expect(screen.getByTestId("states").textContent).toBe("run the tests:sending"));
    act(() => t.setServer([serverInput()]));
    expect(screen.getByTestId("states").textContent).toBe("run the tests:queued");
    await act(async () => finish());
  });

  it("reports a sent message with the session and whether the sender owns it", async () => {
    const track = mock((_event: string, _props: unknown) => {});
    const t = setup(async () => {}, [], track as unknown as TrackFn, false);
    await act(async () => { await t.send("hello"); });
    expect(track).toHaveBeenCalledWith("session_message_sent", { live_session_id: "s1", is_owner: false });
  });

  it("reports nothing when the send fails", async () => {
    const track = mock((_event: string, _props: unknown) => {});
    const t = setup(async () => { throw new Error("queue_full"); }, [], track as unknown as TrackFn, true);
    await act(async () => { await t.send("hello").catch(() => {}); });
    expect(track).not.toHaveBeenCalled();
  });

  it("shows the input a send returns at once, and does not wait for the refetch", async () => {
    const sent = serverInput({ id: "i9", text: "hello", state: "queued" });
    const t = setup(async () => sent, [], undefined, true, () => new Promise<void>(() => {}));
    await act(async () => { await t.send("hello"); });
    await waitFor(() => expect(screen.getByTestId("states").textContent).toBe("hello:queued"));
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect((t.client.getQueryData<SessionStreamData>(sessionStreamKey("s1")))?.inputs.map((i) => i.id)).toEqual(["i9"]);
  });

  it("refetches and waits for it when the send returns no input", async () => {
    let finished = false;
    const t = setup(async () => {}, [], undefined, true, () => new Promise<void>(() => {}));
    void act(() => { void t.send("hello").then(() => (finished = true)); });
    await new Promise((done) => setTimeout(done, 30));
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
  });

  it("rolls the sidebar back when the send fails", async () => {
    const t = setup(async () => { throw new Error("queue_full"); }, [], undefined, true);
    await act(async () => { await t.send("hello").catch(() => {}); });
    expect(t.refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId("states").textContent).toBe("");
  });
});
