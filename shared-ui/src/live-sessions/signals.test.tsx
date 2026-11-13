import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "../query/keys";
import { createRefresher, useSignals, useWorkspaceDataSignals, type WatchSignals } from "./signals";

afterEach(cleanup);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("createRefresher", () => {
  it("runs at once for the first signal", () => {
    const runs: string[][] = [];
    const refresher = createRefresher((events) => void runs.push([...events]), 10);
    refresher.trigger("events");
    expect(runs).toEqual([["events"]]);
  });

  it("gathers a burst of signals into one follow-up run with their names", async () => {
    const runs: string[][] = [];
    const refresher = createRefresher((events) => void runs.push([...events]), 10);
    for (const event of ["events", "inputs", "events", "inputs", "events"]) refresher.trigger(event);
    await wait(40);
    expect(runs).toEqual([["events"], ["inputs", "events"]]);
  });

  it("runs once after a slow run, with the signals that came during it", async () => {
    const runs: string[][] = [];
    let release = () => {};
    const refresher = createRefresher(async (events) => {
      runs.push([...events]);
      if (runs.length === 1) await new Promise<void>((done) => (release = done));
    }, 10);
    refresher.trigger("events");
    refresher.trigger("inputs");
    await wait(30);
    expect(runs).toEqual([["events"]]);
    release();
    await wait(30);
    expect(runs).toEqual([["events"], ["inputs"]]);
  });

  it("does not run the follow-up after stop", async () => {
    const runs: string[][] = [];
    let release = () => {};
    const refresher = createRefresher(async (events) => {
      runs.push([...events]);
      await new Promise<void>((done) => (release = done));
    }, 10);
    refresher.trigger("events");
    refresher.trigger("inputs");
    refresher.stop();
    release();
    await wait(30);
    expect(runs).toEqual([["events"]]);
  });

  it("runs once more when a signal arrives during a run", async () => {
    const runs: string[][] = [];
    let release = () => {};
    const refresher = createRefresher(async (events) => {
      runs.push([...events]);
      if (runs.length === 1) await new Promise<void>((done) => (release = done));
    }, 10);
    refresher.trigger("events");
    await wait(30);
    refresher.trigger("inputs");
    await wait(30);
    expect(runs).toHaveLength(1);
    release();
    await wait(30);
    expect(runs).toEqual([["events"], ["inputs"]]);
  });

  it("keeps going after a failed run and does nothing once stopped", async () => {
    let calls = 0;
    const refresher = createRefresher(() => {
      calls++;
      throw new Error("offline");
    }, 10);
    refresher.trigger("events");
    await wait(30);
    refresher.trigger("events");
    await wait(30);
    expect(calls).toBe(2);
    refresher.stop();
    refresher.trigger("events");
    await wait(30);
    expect(calls).toBe(2);
  });
});

describe("useSignals", () => {
  function Probe({ watch, topic, onSignal }: { watch?: WatchSignals; topic: string | null; onSignal: (events: Set<string>) => void }) {
    useSignals(watch, topic, onSignal);
    return null;
  }

  it("watches the topic while mounted, refreshes on a signal and stops on unmount", async () => {
    const stops: string[] = [];
    let send: (event: string) => void = () => {};
    const watch: WatchSignals = (topic, onSignal) => {
      send = onSignal;
      return () => void stops.push(topic);
    };
    const seen: string[][] = [];
    const view = render(<Probe watch={watch} topic="signals:session:s1" onSignal={(events) => void seen.push([...events])} />);
    send("events");
    await wait(400);
    expect(seen).toEqual([["events"]]);
    view.unmount();
    expect(stops).toEqual(["signals:session:s1"]);
  });

  it("does nothing without a watcher or a topic", () => {
    const view = render(<Probe topic="signals:session:s1" onSignal={() => {}} />);
    view.rerender(<Probe watch={() => () => {}} topic={null} onSignal={() => {}} />);
  });
});

describe("useWorkspaceDataSignals", () => {
  function setup() {
    let send: (event: string) => void = () => {};
    const topics: Array<string | null> = [];
    const client = new QueryClient();
    const fetched: string[] = [];
    for (const name of ["context", "connections", "connectedApps", "runs"] as const) {
      const key = queryKeys[name]("w1");
      void client.prefetchQuery({ queryKey: key, queryFn: async () => (fetched.push(name), name), staleTime: Infinity });
    }
    const watch: WatchSignals = (topic, onSignal) => {
      topics.push(topic);
      send = onSignal;
      return () => {};
    };
    function Probe({ id }: { id: string | null }) {
      useWorkspaceDataSignals(watch, id);
      return null;
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Probe id="w1" />
      </QueryClientProvider>,
    );
    return { client, fetched, topics, send: (event: string) => send(event), view, Probe };
  }

  it("reloads the context, connections, connected apps and runs on a context signal", async () => {
    const t = setup();
    await wait(20);
    t.fetched.length = 0;
    expect(t.topics).toEqual(["signals:workspace:w1"]);
    // Prefetched queries have no observer, so invalidation marks them stale and a fetch needs an active one.
    t.send("context");
    await wait(1700);
    for (const name of ["context", "connections", "connectedApps", "runs"] as const) {
      expect(t.client.getQueryState(queryKeys[name]("w1"))?.isInvalidated).toBe(true);
    }
  });

  it("ignores a session signal, and after a rejoin leaves fresh data alone", async () => {
    const t = setup();
    await wait(20);
    t.fetched.length = 0;
    t.send("sessions");
    t.send("catch-up");
    await wait(1700);
    expect(t.fetched).toEqual([]);
    expect(t.client.getQueryState(queryKeys.context("w1"))?.isInvalidated).toBe(false);
  });

  it("watches nothing while signed out", () => {
    const t = setup();
    t.view.rerender(
      <QueryClientProvider client={t.client}>
        <t.Probe id={null} />
      </QueryClientProvider>,
    );
    expect(t.topics).toEqual(["signals:workspace:w1"]);
  });
});
