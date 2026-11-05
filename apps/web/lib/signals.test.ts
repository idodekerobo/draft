import { afterEach, describe, expect, it } from "bun:test";
import { createSignalWatcher } from "./signals";

type StatusCallback = (status: string) => void;

function fakeClient() {
  const channels: Array<{ topic: string; sendBroadcast(event: string): void; subscribed(): void; removed: boolean }> = [];
  const client = {
    channel(topic: string) {
      let onMessage: (message: { event: string }) => void = () => {};
      let onStatus: StatusCallback = () => {};
      const record = { topic, removed: false, sendBroadcast: (event: string) => onMessage({ event }), subscribed: () => onStatus("SUBSCRIBED") };
      channels.push(record);
      const channel = {
        on: (_type: string, _filter: unknown, callback: typeof onMessage) => {
          onMessage = callback;
          return channel;
        },
        subscribe: (callback: StatusCallback) => {
          onStatus = callback;
          return channel;
        },
      };
      (channel as { record?: typeof record }).record = record;
      return channel;
    },
    removeChannel: async (channel: { record: { removed: boolean } }) => {
      channel.record.removed = true;
      return "ok";
    },
  };
  return { client: client as never, channels };
}

const listeners = new Map<string, Set<() => void>>();
const fakeWindow = {
  addEventListener: (name: string, fn: () => void) => void (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(fn),
  removeEventListener: (name: string, fn: () => void) => void listeners.get(name)?.delete(fn),
};
const fakeDocument = { ...fakeWindow, visibilityState: "visible" };
Object.assign(globalThis, { window: fakeWindow, document: fakeDocument });
const fire = (name: string) => listeners.get(name)?.forEach((fn) => fn());

afterEach(() => listeners.clear());

describe("createSignalWatcher", () => {
  it("passes server signals to the listener and sends catch-up when the channel joins", () => {
    const { client, channels } = fakeClient();
    const seen: string[] = [];
    createSignalWatcher(() => client)("signals:session:s1", (event) => seen.push(event));
    channels[0].subscribed();
    channels[0].sendBroadcast("events");
    expect(seen).toEqual(["catch-up", "events"]);
  });

  it("sends catch-up when a dropped channel rejoins, the browser comes online, and the tab becomes visible", () => {
    const { client, channels } = fakeClient();
    const seen: string[] = [];
    createSignalWatcher(() => client)("signals:session:s1", (event) => seen.push(event));
    channels[0].subscribed();
    channels[0].subscribed();
    fire("online");
    fire("visibilitychange");
    expect(seen).toEqual(["catch-up", "catch-up", "catch-up", "catch-up"]);
  });

  it("shares one channel between two listeners and removes it with the last one", () => {
    const { client, channels } = fakeClient();
    const watch = createSignalWatcher(() => client);
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = watch("signals:workspace:w1", (event) => first.push(event));
    const stopSecond = watch("signals:workspace:w1", (event) => second.push(event));
    expect(channels).toHaveLength(1);
    channels[0].sendBroadcast("context");
    expect([first, second]).toEqual([["context"], ["context"]]);
    stopFirst();
    expect(channels[0].removed).toBe(false);
    stopSecond();
    expect(channels[0].removed).toBe(true);
    expect(listeners.get("online")?.size).toBe(0);
  });
});
