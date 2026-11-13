import { describe, expect, it } from "bun:test";
import { createSignalSource } from "./connect-signals";

function setup() {
  let time = 0;
  const log: string[] = [];
  const channels: Array<{
    topic: string;
    options: unknown;
    deliver(event: string, payload?: unknown): void;
    join(): void;
    sent: unknown[];
  }> = [];
  let tokens = 0;
  const client = {
    realtime: {
      setAuth: async (token: string) => void log.push(`auth:${token}`),
      disconnect: () => void log.push("disconnect"),
    },
    channel(topic: string, options: unknown) {
      let onMessage: (message: { event: string; payload?: unknown }) => void = () => {};
      let onStatus: (status: string) => void = () => {};
      const sent: unknown[] = [];
      channels.push({ topic, options, deliver: (event, payload) => onMessage({ event, payload }), join: () => onStatus("SUBSCRIBED"), sent });
      const channel = {
        on: (_t: string, _f: unknown, fn: typeof onMessage) => {
          onMessage = fn;
          return channel;
        },
        subscribe: (fn: typeof onStatus) => {
          onStatus = fn;
          return channel;
        },
        send: async (message: unknown) => {
          sent.push(message);
          return "ok";
        },
        httpSend: async (event: string, payload: unknown) => {
          sent.push({ http: event, payload });
          return { success: true };
        },
      };
      return channel;
    },
    removeChannel: async () => void log.push("remove"),
  };
  const made = { count: 0 };
  const { source, tick } = createSignalSource({
    makeClient: () => {
      made.count++;
      return client as never;
    },
    getToken: async () => `t${++tokens}`,
    now: () => time,
  });
  return { source, tick, channels, log, made, advance: (ms: number) => void (time += ms) };
}
const flush = () => new Promise((done) => setTimeout(done, 0));

describe("createSignalSource", () => {
  it("sets the token before it joins, passes signals on and says catch-up when the channel joins", async () => {
    const t = setup();
    const heard: string[] = [];
    const connected: boolean[] = [];
    const { leave } = t.source("signals:session:s1", (event) => heard.push(event), (ok) => connected.push(ok));
    await flush();
    expect(t.log).toEqual(["auth:t1"]);
    t.channels[0]!.join();
    expect(connected).toEqual([true]);
    t.channels[0]!.deliver("events");
    expect(heard).toEqual(["catch-up", "events"]);
    leave();
    expect(t.log).toEqual(["auth:t1", "remove", "disconnect"]);
  });

  it("passes the payload of a signal on to the listener", async () => {
    const t = setup();
    const heard: Array<[string, unknown]> = [];
    t.source("live:session:s1", (event, payload) => heard.push([event, payload]), () => {});
    await flush();
    t.channels[0]!.join();
    t.channels[0]!.deliver("text", { messageId: "m1" });
    expect(heard).toEqual([
      ["catch-up", undefined],
      ["text", { messageId: "m1" }],
    ]);
  });

  it("joins a live topic with broadcast.self and a signals topic without it", async () => {
    const t = setup();
    t.source("live:session:s1", () => {}, () => {});
    t.source("signals:session:s1", () => {}, () => {});
    await flush();
    const options = Object.fromEntries(t.channels.map((c) => [c.topic, c.options]));
    expect(options).toEqual({
      "live:session:s1": { config: { private: true, broadcast: { self: true } } },
      "signals:session:s1": { config: { private: true } },
    });
  });

  it("drops a send made before the channel exists, sends over HTTP until it has joined, then on the socket", async () => {
    const t = setup();
    const { send } = t.source("live:session:s1", () => {}, () => {});
    send("text", { text: "early" });
    await flush();
    send("text", { text: "joining" });
    t.channels[0]!.join();
    send("text", { text: "hi" });
    expect(t.channels[0]!.sent).toEqual([
      { http: "text", payload: { text: "joining" } },
      { type: "broadcast", event: "text", payload: { text: "hi" } },
    ]);
  });

  it("uses one client for every topic and refreshes the token only when it is old", async () => {
    const t = setup();
    const leaves = [t.source("a", () => {}, () => {}), t.source("b", () => {}, () => {})];
    await flush();
    expect(t.made.count).toBe(1);
    expect(t.log.filter((entry) => entry.startsWith("auth"))).toEqual(["auth:t1"]);
    leaves.forEach(({ leave }) => leave());
  });

  it("refreshes the token every ten minutes", async () => {
    const t = setup();
    const { leave } = t.source("a", () => {}, () => {});
    await flush();
    for (let step = 0; step < 36; step++) {
      t.advance(15_000);
      await t.tick();
    }
    expect(t.log.filter((entry) => entry.startsWith("auth"))).toEqual(["auth:t1"]);
    for (let step = 0; step < 4; step++) {
      t.advance(15_000);
      await t.tick();
    }
    expect(t.log.filter((entry) => entry.startsWith("auth"))).toEqual(["auth:t1", "auth:t2"]);
    leave();
  });

  it("refreshes the token and says catch-up to every topic after a sleep", async () => {
    const t = setup();
    const heard: string[] = [];
    const { leave } = t.source("a", (event) => heard.push(event), () => {});
    await flush();
    t.advance(1_000);
    await t.tick();
    t.advance(2 * 60_000);
    await t.tick();
    expect(heard).toEqual(["catch-up"]);
    expect(t.log.filter((entry) => entry.startsWith("auth"))).toEqual(["auth:t1", "auth:t2"]);
    leave();
  });

  it("does not join a topic that was left before the token arrived", async () => {
    const t = setup();
    t.source("a", () => {}, () => {}).leave();
    await flush();
    expect(t.channels).toHaveLength(0);
  });
});
