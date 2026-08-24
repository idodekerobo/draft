import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  connectSlackSocketListener,
  SlackSocketOpenError,
  classifySlackListenerFailure,
  type SlackSocketListenerDependencies,
  nextReconnectDelay,
} from "../../../ingestion/slack/socket-listener";

const connection = { id: "conn-1", workspace_id: "workspace-1", organization_id: "org-1" };

function statusClient(initialStatus: string) {
  let status = initialStatus;
  let lookups = 0;
  let lookupError: unknown = null;
  let updateAttempts = 0;
  let updatesApplied = 0;
  const client = {
    from(table: string) {
      if (table !== "source_connections") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                lookups += 1;
                return lookupError
                  ? { data: null, error: lookupError }
                  : { data: { status }, error: null };
              },
            }),
          }),
        }),
        update: (payload: { status: string }) => ({
          eq: () => ({
            eq: () => ({
              in: async (_column: string, allowedStatuses: string[]) => {
                updateAttempts += 1;
                if (allowedStatuses.includes(status)) {
                  status = payload.status;
                  updatesApplied += 1;
                }
                return { data: null, error: null };
              },
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
  return {
    client,
    setStatus(next: string) { status = next; },
    setLookupError(error: unknown) { lookupError = error; },
    get status() { return status; },
    get lookups() { return lookups; },
    get updateAttempts() { return updateAttempts; },
    get updatesApplied() { return updatesApplied; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeWebSocket {
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  sent: string[] = [];
  closed = false;

  send(value: string): void { this.sent.push(value); }
  close(): void { this.closed = true; }
}

function listenerDependencies(overrides: Partial<SlackSocketListenerDependencies> = {}) {
  const sockets: FakeWebSocket[] = [];
  const reconnectCallbacks: Array<() => void> = [];
  const resolveCredential = mock(async () => ({ bot_token: "xoxb", app_token: "xapp" }));
  const openSocketMode = mock(async () => "wss://slack.test/socket");
  const handleMessage = mock(async () => undefined);
  const dependencies: Partial<SlackSocketListenerDependencies> = {
    resolveCredential,
    openSocketMode,
    createWebSocket: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    handleMessage,
    setTimeoutFn: (callback) => {
      reconnectCallbacks.push(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => undefined,
    ...overrides,
  };
  return { dependencies, sockets, reconnectCallbacks, resolveCredential, openSocketMode, handleMessage };
}

describe("nextReconnectDelay", () => {
  it("doubles the delay", () => {
    expect(nextReconnectDelay(1_000)).toBe(2_000);
    expect(nextReconnectDelay(2_000)).toBe(4_000);
    expect(nextReconnectDelay(30_000)).toBe(60_000);
  });

  it("caps at the max delay", () => {
    expect(nextReconnectDelay(250_000)).toBe(300_000);
    expect(nextReconnectDelay(300_000)).toBe(300_000);
    expect(nextReconnectDelay(1_000_000)).toBe(300_000);
  });

  it("respects a custom max", () => {
    expect(nextReconnectDelay(8_000, 10_000)).toBe(10_000);
    expect(nextReconnectDelay(4_000, 10_000)).toBe(8_000);
  });
});

describe("classifySlackListenerFailure", () => {
  it("does not retry terminal Slack authentication failures", () => {
    expect(classifySlackListenerFailure(new SlackSocketOpenError("invalid_auth"))).toEqual({
      retryable: false,
      connectionStatus: "revoked",
    });
    expect(classifySlackListenerFailure(new SlackSocketOpenError("token_revoked")).retryable).toBe(false);
  });

  it("retries transient Slack and network failures", () => {
    expect(classifySlackListenerFailure(new SlackSocketOpenError("internal_error"))).toEqual({
      retryable: true,
    });
    expect(classifySlackListenerFailure(new TypeError("fetch failed"))).toEqual({ retryable: true });
  });
});

describe("connectSlackSocketListener lifecycle gates", () => {
  it.each(["pending", "error", "revoked"])(
    "does not resolve credentials or open Socket Mode for an inactive %s connection",
    async (status) => {
      const state = statusClient(status);
      const deps = listenerDependencies();

      connectSlackSocketListener(connection, state.client, deps.dependencies);
      await Bun.sleep(0);

      expect(state.lookups).toBe(1);
      expect(deps.resolveCredential).not.toHaveBeenCalled();
      expect(deps.openSocketMode).not.toHaveBeenCalled();
      expect(deps.sockets).toHaveLength(0);
    },
  );

  it("rechecks status before a reconnect and stops when the connection became inactive", async () => {
    const state = statusClient("active");
    const deps = listenerDependencies();

    connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    expect(deps.sockets).toHaveLength(1);

    deps.sockets[0]!.onclose?.({} as CloseEvent);
    expect(deps.reconnectCallbacks).toHaveLength(1);
    state.setStatus("revoked");
    deps.reconnectCallbacks[0]!();
    await Bun.sleep(0);

    expect(state.lookups).toBe(3);
    expect(deps.openSocketMode).toHaveBeenCalledTimes(1);
    expect(deps.sockets).toHaveLength(1);
  });

  it("does not create a socket when stopped during credential resolution", async () => {
    const state = statusClient("active");
    const credential = deferred<{ bot_token: string; app_token: string }>();
    const resolveCredential = mock(() => credential.promise);
    const deps = listenerDependencies({ resolveCredential });

    const handle = connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    expect(resolveCredential).toHaveBeenCalledTimes(1);

    handle.stop();
    credential.resolve({ bot_token: "xoxb", app_token: "xapp" });
    await Bun.sleep(0);

    expect(deps.openSocketMode).not.toHaveBeenCalled();
    expect(deps.sockets).toHaveLength(0);
  });

  it("does not create a socket when stopped during Socket Mode setup", async () => {
    const state = statusClient("active");
    const socketUrl = deferred<string>();
    const openSocketMode = mock(() => socketUrl.promise);
    const deps = listenerDependencies({ openSocketMode });

    const handle = connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    expect(openSocketMode).toHaveBeenCalledTimes(1);

    handle.stop();
    socketUrl.resolve("wss://slack.test/socket");
    await Bun.sleep(0);

    expect(deps.sockets).toHaveLength(0);
  });

  it("ignores a terminal setup failure after the listener was stopped", async () => {
    const state = statusClient("active");
    const socketUrl = deferred<string>();
    const deps = listenerDependencies({ openSocketMode: () => socketUrl.promise });

    const handle = connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    handle.stop();
    socketUrl.reject(new SlackSocketOpenError("invalid_auth"));
    await Bun.sleep(0);

    expect(state.updateAttempts).toBe(0);
    expect(state.status).toBe("active");
    expect(deps.sockets).toHaveLength(0);
  });

  it("rechecks status after Socket Mode setup before creating a socket", async () => {
    const state = statusClient("active");
    const socketUrl = deferred<string>();
    const deps = listenerDependencies({ openSocketMode: () => socketUrl.promise });

    connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    state.setStatus("revoked");
    socketUrl.resolve("wss://slack.test/socket");
    await Bun.sleep(0);

    expect(state.lookups).toBe(2);
    expect(deps.sockets).toHaveLength(0);
  });

  it("does not overwrite a disconnect that wins the race with a terminal open failure", async () => {
    const state = statusClient("active");
    const socketUrl = deferred<string>();
    const deps = listenerDependencies({ openSocketMode: () => socketUrl.promise });

    connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    state.setStatus("revoked");
    socketUrl.reject(new SlackSocketOpenError("invalid_auth"));
    await Bun.sleep(0);

    expect(state.updateAttempts).toBe(1);
    expect(state.updatesApplied).toBe(0);
    expect(state.status).toBe("revoked");
  });

  it("rechecks status before handing a message to normalization", async () => {
    const state = statusClient("active");
    const deps = listenerDependencies();

    connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    const socket = deps.sockets[0]!;
    state.setStatus("revoked");

    await socket.onmessage?.({
      data: JSON.stringify({
        envelope_id: "envelope-1",
        type: "events_api",
        payload: { event: { type: "message", channel: "C1", ts: "1.0" } },
      }),
    } as MessageEvent);

    expect(state.lookups).toBe(3);
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope-1" })]);
    expect(deps.handleMessage).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
  });

  it("does not ACK a message when the status lookup fails and closes for redelivery", async () => {
    const state = statusClient("active");
    const deps = listenerDependencies();

    connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    const socket = deps.sockets[0]!;
    state.setLookupError({ message: "database unavailable" });

    await socket.onmessage?.({
      data: JSON.stringify({
        envelope_id: "envelope-error",
        type: "events_api",
        payload: { event: { type: "message", channel: "C1", ts: "1.0" } },
      }),
    } as MessageEvent);

    expect(socket.sent).toEqual([]);
    expect(deps.handleMessage).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);

    socket.onclose?.({} as CloseEvent);
    expect(deps.reconnectCallbacks).toHaveLength(1);
  });

  it("ACKs non-message envelopes without an additional status lookup", async () => {
    const state = statusClient("active");
    const deps = listenerDependencies();

    connectSlackSocketListener(connection, state.client, deps.dependencies);
    await Bun.sleep(0);
    const socket = deps.sockets[0]!;

    await socket.onmessage?.({
      data: JSON.stringify({ envelope_id: "envelope-other", type: "slash_commands" }),
    } as MessageEvent);

    expect(state.lookups).toBe(2);
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope-other" })]);
  });
});
