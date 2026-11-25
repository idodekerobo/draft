import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMcpBridge, hostMcpDir } from "./mcp-bridge";
import { McpTransportError } from "./mcp-transport";
const id = "11111111-1111-4111-8111-111111111111";
const binding = { sessionId: id, workspaceId: "workspace", hostId: "host" };
const newDir = () => mkdtempSync(join(tmpdir(), "draft-mcp-test-"));
function bridge(directory: string, send = async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} })) {
  return new SessionMcpBridge({ directory, apiUrl: "https://api.test", workspaceId: () => "workspace", send });
}
async function rpc(connection: NonNullable<Awaited<ReturnType<SessionMcpBridge["prepare"]>>>, envelope: unknown, token = connection.token) {
  return fetch(connection.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(envelope) });
}

test("restart restores endpoint and capability and same-namespace ownership cannot overwrite it", async () => {
  const directory = newDir(); const first = bridge(directory); const second = bridge(directory);
  try {
    const connection = (await first.prepare(binding))!;
    expect(connection).toBeDefined();
    expect((await rpc(connection, { method: "initialize", id: 1 })).status).toBe(200);
    expect((await rpc(connection, { method: "initialize", id: 1 }, "bad")).status).toBe(403);
    expect(statSync(connection.tokenFile).mode & 0o777).toBe(0o600);
    expect(await second.prepare(binding)).toBeUndefined();
    await first.close();
    const restored = (await second.prepare(binding))!;
    expect(restored.url).toBe(connection.url); expect(restored.token).toBe(connection.token);
    expect((await rpc(connection, { method: "initialize", id: 1 })).status).toBe(200);
    second.release(id);
    expect((await rpc(connection, { method: "initialize", id: 1 })).status).toBe(403);
  } finally { await first.close(); await second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("occupied persisted port produces unavailability without repointing surviving panes", async () => {
  const directory = newDir(); const first = bridge(directory); const second = bridge(directory);
  let occupied: ReturnType<typeof Bun.serve> | undefined;
  try {
    const connection = (await first.prepare(binding))!; const port = Number(new URL(connection.url).port);
    await first.close(); occupied = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    expect(await second.prepare(binding)).toBeUndefined();
    expect(second.status.get(id).status?.reason).toBe("bridge_port_unavailable");
    await occupied.stop(true); occupied = undefined;
    expect((await second.prepare(binding))?.url).toBe(connection.url);
  } finally { await occupied?.stop(true); await first.close(); await second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("auth failures become MCP errors without challenges, and notifications get no response", async () => {
  const directory = newDir(); const host = bridge(directory, async () => { throw new McpTransportError("sign_in_required"); });
  try {
    const connection = (await host.prepare(binding))!;
    const result = await rpc(connection, { method: "tools/call", id: 5 });
    expect(result.status).toBe(200); expect(result.headers.has("www-authenticate")).toBe(false);
    expect((await result.json() as { result: { isError: boolean } }).result.isError).toBe(true);
    expect((await rpc(connection, { method: "initialize", id: 6 })).status).toBe(503);
    expect((await rpc(connection, { method: "notifications/initialized" })).status).toBe(202);
    expect(host.status.get(id).status?.reason).toBe("sign_in_required");
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("rotation preserves the pane's URL/token but changes the bound session and revokes it on end", async () => {
  const directory = newDir(); let actingSession = "";
  const host = new SessionMcpBridge({ directory, apiUrl: "https://api.test", workspaceId: () => "workspace", send: async (bound) => { actingSession = bound.sessionId; return Response.json({ result: {} }); } });
  try {
    const connection = (await host.prepare(binding))!;
    const next = "22222222-2222-4222-8222-222222222222";
    await host.transfer(id, { ...binding, sessionId: next });
    await rpc(connection, { method: "tools/list", id: 1 }); expect(actingSession).toBe(next);
    host.release(next); expect((await rpc(connection, { method: "tools/list", id: 1 })).status).toBe(403);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("build channels have independent persistent directories", () => {
  expect(hostMcpDir("/test", true)).toBe("/test/.draft/host-dev/mcp");
  expect(hostMcpDir("/test", false)).toBe("/test/.draft/host/mcp");
});

test("dev and installed processes restore their own endpoints without interference", async () => {
  const home = newDir();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const start = async (dev: boolean) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "mcp-bridge-child.ts"), hostMcpDir(home, dev)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      children.push(child);
      const reader = child.stdout.getReader(); const first = await reader.read();
      const result = JSON.parse(new TextDecoder().decode(first.value)); reader.releaseLock();
      return { child, url: result.url as string };
    };
    const dev = await start(true); const installed = await start(false);
    expect(dev.url).toBeString(); expect(installed.url).toBeString(); expect(dev.url).not.toBe(installed.url);
    dev.child.stdin.write("stop\n"); expect(await dev.child.exited).toBe(0);
    const restarted = await start(true); expect(restarted.url).toBe(dev.url);
    expect((await fetch(installed.url)).status).toBe(403);
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    rmSync(home, { recursive: true, force: true });
  }
});
