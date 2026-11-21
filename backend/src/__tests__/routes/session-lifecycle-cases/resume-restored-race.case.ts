import { expect, it, mock } from "bun:test";
import { tables, rpcResult, updates, session, routes, WS, SESSION } from "./fixture";

it("restored ended host cannot kill a resumed Codex connection", async () => {
  
  const observations: object[] = [];
  const observe = (phase: string, detail = {}) => { const e = { at: new Date().toISOString(), phase, ...detail }; observations.push(e); console.info(JSON.stringify(e)); };
  const waitFor = async (check: () => boolean) => { const deadline = Date.now() + 4000; while (!check() && Date.now() < deadline) await Bun.sleep(10); expect(check()).toBe(true); };
  const servers: Array<{ server: ReturnType<typeof Bun.serve>; socket: any; stopped: boolean }> = [];
  let rejectNextResume = false;
  const drivers: any[] = [];
  let saved: any = null;
  let deletes = 0;
  mock.module("../../../../../core/src/host/failures", () => ({ flushSessionFailures: async () => {}, reportSessionFailure: () => ({ id: crypto.randomUUID(), message: "failure" }) }));
  mock.module("../../../../../core/src/host/cursor-store", () => ({ loadRetiredStates: () => [], saveRetiredState() {}, deleteRetiredState() {}, saveState(s: any) { saved = s; }, loadStates: () => [{ sessionId: SESSION, workspaceId: WS, hostId: "host-1", nativeSessionId: "native-test", folderPath: "/private/tmp", harness: "codex", ended: true, cursors: {}, rawUploads: {} }], deleteState() { deletes++; saved = null; } }));
  mock.module("../../../../../core/src/host/find-bin", () => ({ findHarnessBin: () => "fake-codex" }));
  mock.module("../../../../../core/src/host/drivers/codex/app-server-process", () => ({ startAppServer: async () => {
    const entry: any = { stopped: false, socket: null };
    entry.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) { if (server.upgrade(req)) return; return new Response("upgrade required", { status: 400 }); }, websocket: {
      open(ws) { entry.socket = ws; },
      message(ws, raw) { const m = JSON.parse(String(raw)); if (m.id == null) return;
        if (m.method === "thread/resume" && rejectNextResume) { rejectNextResume = false; ws.send(JSON.stringify({ id: m.id, error: { code: -1, message: "controlled resume rejection" } })); return; }
        ws.send(JSON.stringify({ id: m.id, result: m.method === "thread/resume" ? { thread: { turns: [] }, cwd: "/private/tmp", model: "test" } : {} }));
      }, close() {},
    }});
    servers.push(entry);
    observe("transport.created", { number: servers.length });
    return { url: entry.server.url.toString().replace("http:", "ws:"), token: "test", exited: new Promise(() => {}), stop() { entry.stopped = true; entry.socket?.close(); entry.server.stop(true); observe("transport.stopped", { number: servers.indexOf(entry) + 1 }); } };
  } }));
  const { codex } = await import("../../../../../core/src/host/drivers/codex/codex-driver");
  codex.launcher.check = async () => ({ ok: true, bin: "fake-codex", version: "test" });
  mock.module("../../../../../core/src/host/drivers/drivers", () => ({ registrationFor: () => ({ launcher: codex.launcher, createDriver(host: any) {
    const driver = codex.createDriver(host);
    drivers.push(driver); return driver;
  } }) }));
  const { installHostServices } = await import("../../../../../core/src/host/services");
  const { resumeLiveSession, resumeLiveSessions } = await import("../../../../../core/src/host/live-session");
  tables.sessions = [session({ session_type: "interactive", status: "ended", end_reason: "exited", native_session_id: "native-test", runtime: "local", mine: true, harness: "codex" })];
  rpcResult.data = "live"; rpcResult.error = null;
  const api = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    const params = { id: WS, sessionId: SESSION };
    if (path.endsWith("/events")) return Response.json({ session: tables.sessions[0], events: [] });
    if (path.endsWith("/reopen")) { const r = await routes.REOPEN(Object.assign(req, { params }) as never); if (r.ok) Object.assign(tables.sessions[0]!, updates.at(-1)!.payload); observe("server.reopened"); return r; }
    if (path.endsWith("/end")) { const body = await req.clone().json() as { reason: string }; const r = await routes.END(Object.assign(req, { params }) as never); if (r.ok) Object.assign(tables.sessions[0]!, { status: "ended", end_reason: body.reason }); observe("server.ended", { reason: body.reason }); return r; }
    if (path.endsWith("/heartbeat")) return routes.HEARTBEAT(Object.assign(req, { params }) as never);
    return Response.json({ inputs: [] });
  }});
  installHostServices({ workspaceId: () => WS, hostId: () => "host-1", fetchServer: (path, init) => fetch(new URL(path, api.url).toString(), init), fetchServerJSON: async <T>(path: string, init?: RequestInit) => (await fetch(new URL(path, api.url).toString(), init)).json() as Promise<T>, realtime: { connected: () => false, watch: () => () => {}, send() {} }, capture: async () => { throw Error("unexpected capture"); }, openInTerminal: async () => ({ ok: true }) });
  try {
    await resumeLiveSessions();
    expect(drivers.length).toBe(1);
    observe("ended-host.restored.with.real.poll.timer");
    expect(await resumeLiveSession(SESSION)).toEqual({ ok: true });
    expect(servers.length).toBe(1);
    expect(servers[0]!.stopped).toBe(false);
    observe("resumed.connection.live");
    await Bun.sleep(1100);
    expect(servers[0]!.stopped).toBe(false);
    expect(tables.sessions[0]!.status).toBe("live");
    expect(saved?.ended).toBe(false);
    expect(deletes).toBe(0);
    expect(await resumeLiveSession(SESSION)).toEqual({ ok: false, error: "This session is already running." });
    expect(servers.length).toBe(1);
    rejectNextResume = true;
    expect(await codex.launcher.resume({ sessionId: "rejected", nativeSessionId: "native", model: null, effort: null, options: { bin: "fake" } }).then(() => false, () => true)).toBe(true);
    expect(servers.at(-1)!.stopped).toBe(true);
    observe("startup.rejection.closes.only.its.transport");
  } finally { for (const driver of drivers) driver.dispose(); for (const entry of servers) entry.server.stop(true); api.stop(true); }
}, 15000);
