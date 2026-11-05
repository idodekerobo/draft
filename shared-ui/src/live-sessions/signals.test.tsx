import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { createRefresher, useSignals, type WatchSignals } from "./signals";

afterEach(cleanup);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("createRefresher", () => {
  it("runs once for a burst of signals and passes their names", async () => {
    const runs: string[][] = [];
    const refresher = createRefresher((events) => void runs.push([...events]), 10);
    refresher.trigger("events");
    refresher.trigger("inputs");
    refresher.trigger("events");
    await wait(40);
    expect(runs).toEqual([["events", "inputs"]]);
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
    await wait(160);
    expect(seen).toEqual([["events"]]);
    view.unmount();
    expect(stops).toEqual(["signals:session:s1"]);
  });

  it("does nothing without a watcher or a topic", () => {
    const view = render(<Probe topic="signals:session:s1" onSignal={() => {}} />);
    view.rerender(<Probe watch={() => () => {}} topic={null} onSignal={() => {}} />);
  });
});
