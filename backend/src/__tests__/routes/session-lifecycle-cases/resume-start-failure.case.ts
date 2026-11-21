import { expect, it, mock } from "bun:test";
import { tables, session, WS, SESSION } from "./fixture";

it("logs a host-start failure, stops its process, and saves an ended state", async () => {
  let saved: any;
  let stopped = false;
  let failure: any;
  mock.module("../../../../../core/src/host/failures", () => ({ flushSessionFailures: async () => {}, reportSessionFailure: (input: any) => { failure = input; tables.sessions[0]!.status = "ended"; return { id: crypto.randomUUID(), message: "Codex could not resume this session." }; } }));
  mock.module("../../../../../core/src/host/cursor-store", () => ({ loadStates: () => [], saveState(s: any) { saved = s; }, deleteState() {}, loadRetiredStates: () => [], saveRetiredState() {}, deleteRetiredState() {} }));
  mock.module("../../../../../core/src/host/drivers/drivers", () => ({ registrationFor: () => ({
    launcher: { check: async () => ({ ok: true, bin: "codex", version: "test" }), resume: async () => ({ folderPath: "/private/tmp" }) },
    createDriver: () => ({ start() { throw Error("host startup failed"); }, halt() {}, dispose() {}, stop: async () => { stopped = true; }, finalize: async () => true, isAlive: async () => true }),
  }) }));
  const { installHostServices } = await import("../../../../../core/src/host/services");
  const { resumeLiveSession, hostedLiveSessionIds } = await import("../../../../../core/src/host/live-session");
  tables.sessions = [session({ status: "ended", session_type: "interactive", native_session_id: "native", runtime: "local", mine: true, harness: "codex" })];
  installHostServices({ workspaceId: () => WS, hostId: () => "host-1",
    fetchServer: async () => Response.json({ ok: true }), fetchServerJSON: async <T>() => ({ session: tables.sessions[0], events: [], inputs: [] }) as T,
    realtime: { connected: () => false, watch: () => () => {}, send() {} }, capture: async () => { throw Error("unused"); }, openInTerminal: async () => ({ ok: true }),
  });
  expect(await resumeLiveSession(SESSION)).toMatchObject({ ok: false, code: "resume_failed" });
  expect(failure).toMatchObject({ sessionId: SESSION, terminal: true, code: "resume_failed" });
  expect(stopped).toBe(true);
  expect(saved.ended).toBe(true);
  expect(hostedLiveSessionIds()).not.toContain(SESSION);
});
