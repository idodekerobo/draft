import { expect, it, mock } from "bun:test";
import { tables, rpcResult, updates, session, routes, WS, SESSION } from "./fixture";

it("retires Claude uploads separately and rejects stale writes to the resumed state", async () => {
  let primary: any = null;
  let deletes = 0;
  const archives = new Map<string, any>();
  const hosts: any[] = [];
  let finalizations = 0;
  const old = { sessionId: SESSION, workspaceId: WS, hostId: "host-1", nativeSessionId: "native", folderPath: "/private/tmp", harness: "claude", ended: true, cursors: {}, rawUploads: {} };
  mock.module("../../../../../core/src/host/failures", () => ({ flushSessionFailures: async () => {}, reportSessionFailure: () => ({ id: crypto.randomUUID(), message: "failure" }) }));
  mock.module("../../../../../core/src/host/cursor-store", () => ({
    loadStates: () => [old], saveState(s: any) { primary = structuredClone(s); }, deleteState() { deletes++; },
    loadRetiredStates: () => [], saveRetiredState(s: any, id: string) { archives.set(id, structuredClone(s)); }, deleteRetiredState(id: string) { archives.delete(id); },
  }));
  mock.module("../../../../../core/src/host/drivers/drivers", () => ({ registrationFor: () => ({
    launcher: { check: async () => ({ ok: true, bin: "claude", version: "test" }), resume: async () => ({ folderPath: "/private/tmp", tmuxSession: "new-pane" }) },
    createDriver(host: any) { const index = hosts.length; hosts.push(host); return {
      start() { host.persist({ harnessVersion: "new" }); }, halt() {}, dispose() {}, isAlive: async () => true,
      pollMs: () => 10, flush: async () => true, refresh: async () => true, serve: async () => {},
      finalize: async () => { if (index !== 0) return true; finalizations++; if (finalizations === 1) return false; host.persist({ rawUploads: { old: { size: 1, mtimeMs: 1 } } }); return true; },
    }; },
  }) }));
  const { installHostServices } = await import("../../../../../core/src/host/services");
  const { resumeLiveSession, resumeLiveSessions, hostedLiveSessionIds } = await import("../../../../../core/src/host/live-session");
  tables.sessions = [session({ status: "ended", session_type: "interactive", native_session_id: "native", runtime: "local", mine: true, harness: "claude" })];
  installHostServices({ workspaceId: () => WS, hostId: () => "host-1",
    fetchServer: async (path, init) => { if (path.endsWith("/reopen")) tables.sessions[0]!.status = "live"; return Response.json({ ok: true }); },
    fetchServerJSON: async <T>(path: string) => ({ session: tables.sessions[0], events: [], inputs: [] }) as T,
    realtime: { connected: () => false, watch: () => () => {}, send() {} }, capture: async () => { throw Error("unused"); }, openInTerminal: async () => ({ ok: true }),
  });
  await resumeLiveSessions();
  expect(await resumeLiveSession(SESSION)).toEqual({ ok: true });
  expect(archives.size).toBe(1);
  await Bun.sleep(60);
  expect(finalizations).toBeGreaterThanOrEqual(2);
  expect(archives.size).toBe(0);
  expect(primary.ended).toBe(false);
  expect(primary.tmuxSession).toBe("new-pane");
  expect(primary.rawUploads).toEqual({});
  hosts[0].persist({ ended: true, rawUploads: { stale: { size: 5, mtimeMs: 5 } } });
  expect(primary.ended).toBe(false);
  expect(primary.rawUploads).toEqual({});
  expect(deletes).toBe(0);
  expect(hostedLiveSessionIds()).toContain(SESSION);
});
