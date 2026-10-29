import { afterEach, describe, expect, it } from "bun:test";
import { RpcClient, RpcError } from "./rpc-client";

type Socket = { send(data: string): void };

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

/** A server that answers `echo` and `fail`, and sends a notification and a request on `hello`. */
function startServer(onOpen?: (ws: Socket) => void) {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (req.headers.get("authorization") !== "Bearer secret") return new Response("no", { status: 401 });
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open: (ws) => onOpen?.(ws),
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        if (message.method === "echo") ws.send(JSON.stringify({ id: message.id, result: message.params }));
        else if (message.method === "fail") ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "nope" } }));
        else if (message.method === "hello") {
          ws.send(JSON.stringify({ method: "turn/started", params: { n: 1 } }));
          ws.send(JSON.stringify({ id: 77, method: "item/commandExecution/requestApproval", params: { command: "ls" } }));
          ws.send(JSON.stringify({ id: message.id, result: {} }));
        } else if (message.id === 77) ws.send(JSON.stringify({ method: "got-answer", params: message.result }));
      },
    },
  });
  return `ws://127.0.0.1:${server.port}`;
}

const handlers = () => {
  const seen = { notifications: [] as Array<[string, unknown]>, requests: [] as Array<[number | string, string]>, closed: 0 };
  return {
    seen,
    handlers: {
      onNotification: (method: string, params: unknown) => seen.notifications.push([method, params]),
      onRequest: (id: number | string, method: string) => seen.requests.push([id, method]),
      onClose: () => seen.closed++,
    },
  };
}

describe("RpcClient", () => {
  it("matches responses to requests by id and turns an error reply into RpcError", async () => {
    const url = startServer();
    const { handlers: h } = handlers();
    const rpc = await RpcClient.connect(url, "secret", h);
    expect(await rpc.request("echo", { a: 1 })).toEqual({ a: 1 });
    const failure = await rpc.request("fail", {}).catch((error) => error);
    expect(failure).toBeInstanceOf(RpcError);
    expect((failure as RpcError).code).toBe(-32600);
    rpc.close();
  });

  it("passes notifications and server requests to the handlers, and sends the answer back", async () => {
    const url = startServer();
    const { handlers: h, seen } = handlers();
    const rpc = await RpcClient.connect(url, "secret", h);
    await rpc.request("hello", {});
    expect(seen.notifications).toEqual([["turn/started", { n: 1 }]]);
    expect(seen.requests).toEqual([[77, "item/commandExecution/requestApproval"]]);
    rpc.respond(77, { decision: "accept" });
    await Bun.sleep(50);
    expect(seen.notifications.at(-1)).toEqual(["got-answer", { decision: "accept" }]);
    rpc.close();
  });

  it("fails waiting requests and reports the close when the server goes away", async () => {
    const url = startServer();
    const { handlers: h, seen } = handlers();
    const rpc = await RpcClient.connect(url, "secret", h);
    server?.stop(true);
    await Bun.sleep(100);
    expect(rpc.isOpen()).toBe(false);
    expect(seen.closed).toBe(1);
    await expect(rpc.request("echo", {})).rejects.toThrow();
  });
});
