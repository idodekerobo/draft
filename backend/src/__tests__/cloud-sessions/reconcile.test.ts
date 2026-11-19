import { describe, expect, it, mock } from "bun:test";
import { reconcileCloudSessions } from "../../cloud-sessions/reconcile";
import type { SandboxProvider, SandboxRef } from "../../metaharness/sandbox/providers";
import { fakeClient, fakeDb, failingOn, type FakeDb } from "../routines/fake-client";

type Row = Record<string, unknown>;

const WS = "ws-1";
const NOW = new Date("2026-11-18T10:00:00.000Z");
/** An hour before now: past the ten-minute grace for a run or a silent host. */
const LONG_AGO = "2026-11-18T09:00:00.000Z";
/** Five minutes before now: inside the grace. */
const RECENT = "2026-11-18T09:55:00.000Z";
const VOLUME_OF = (id: string) => ({ provider: "fly", id: `vol-${id}`, region: "iad" });

function session(id: string, overrides: Row = {}): Row {
  return {
    id,
    workspace_id: WS,
    runtime: "cloud",
    session_type: "interactive",
    status: "host_offline",
    last_seen: LONG_AGO,
    deleted_at: null,
    sandbox_volume: VOLUME_OF(id),
    ...overrides,
  };
}

function run(sessionId: string, overrides: Row = {}): Row {
  return {
    id: `run-${sessionId}`,
    workspace_id: WS,
    session_id: sessionId,
    status: "running",
    sandbox_machine_id: `machine-${sessionId}`,
    created_at: LONG_AGO,
    ...overrides,
  };
}

function input(sessionId: string, state: string): Row {
  return { id: crypto.randomUUID(), session_id: sessionId, workspace_id: WS, kind: "message", state };
}

type MachineState = "running" | "stopped" | "missing";

/** A provider that answers each machine's state from a map. A machine in `statusFails` or `destroyFails` makes that call throw. */
function fakeProvider(options: { states?: Record<string, MachineState>; statusFails?: string[]; destroyFails?: string[] } = {}) {
  const statusCalls: SandboxRef[] = [];
  const destroyed: SandboxRef[] = [];
  const provider: SandboxProvider = {
    async create() {
      throw new Error("not used by the reconcile sweep");
    },
    async start() {
      throw new Error("not used by the reconcile sweep");
    },
    async stop() {
      throw new Error("not used by the reconcile sweep");
    },
    async destroy(ref) {
      if (options.destroyFails?.includes(ref.machine)) throw new Error("Fly is unavailable");
      destroyed.push(ref);
    },
    async destroyMachine() {
      throw new Error("not used by the reconcile sweep");
    },
    async status(ref) {
      statusCalls.push(ref);
      if (options.statusFails?.includes(ref.machine)) throw new Error("Fly returned 503");
      return options.states?.[ref.machine] ?? "running";
    },
  };
  return { provider, destroyed, statusCalls };
}

function deps(db: FakeDb, provider: SandboxProvider, wake = mock(async () => ({ status: "woken" }))) {
  return { client: fakeClient(db), provider, providerName: "fly", wake, now: () => NOW };
}

const byId = (db: FakeDb) => Object.fromEntries(db.tables.sessions!.map((row) => [row.id, row]));
const runById = (db: FakeDb, id: string) => db.tables.agent_runs!.find((row) => row.id === id);
const errorRows = (db: FakeDb) => db.tables.errors!;
const errorCodes = (db: FakeDb) => errorRows(db).map((row) => (row.detail_json as { code?: string }).code);

describe("reconcileCloudSessions: stuck hosts", () => {
  it("fails the run and sleeps the session of a host whose machine is missing", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1")], session_inputs: [], errors: [] });
    const { provider } = fakeProvider({ states: { "machine-s1": "missing" } });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result).toEqual({ hostsLost: 1, volumesDestroyed: 0, seedsRemoved: 0, failed: 0 });
    expect(runById(db, "run-s1")).toMatchObject({ status: "failed", failure_code: "host_lost", completed_at: NOW.toISOString() });
    expect(byId(db).s1).toMatchObject({ status: "sleeping" });
    expect(errorRows(db)[0]).toMatchObject({ agent_run_id: "run-s1", session_id: "s1" });
    expect(errorRows(db)[0]!.detail_json).toMatchObject({ code: "host_lost", machine_state: "missing" });
  });

  it("treats a stopped machine the same way as a missing one", async () => {
    const db = fakeDb({ sessions: [session("s1", { status: "starting", last_seen: LONG_AGO })], agent_runs: [run("s1")], session_inputs: [], errors: [] });
    const { provider } = fakeProvider({ states: { "machine-s1": "stopped" } });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result.hostsLost).toBe(1);
    expect(runById(db, "run-s1")).toMatchObject({ status: "failed", failure_code: "host_lost" });
    expect(byId(db).s1).toMatchObject({ status: "sleeping" });
    expect(errorRows(db)[0]!.detail_json).toMatchObject({ machine_state: "stopped" });
  });

  it("leaves a host whose machine still runs to the heartbeat sweep", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1")], session_inputs: [], errors: [] });
    const { provider, statusCalls } = fakeProvider({ states: { "machine-s1": "running" } });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result).toEqual({ hostsLost: 0, volumesDestroyed: 0, seedsRemoved: 0, failed: 0 });
    expect(statusCalls).toHaveLength(1);
    expect(runById(db, "run-s1")).toMatchObject({ status: "running" });
    expect(byId(db).s1).toMatchObject({ status: "host_offline" });
    expect(errorRows(db)).toEqual([]);
  });

  it("skips a young run, since the host may still be booting", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1", { created_at: RECENT })], session_inputs: [], errors: [] });
    const { provider, statusCalls } = fakeProvider({ states: { "machine-s1": "missing" } });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result.hostsLost).toBe(0);
    expect(statusCalls).toEqual([]);
    expect(byId(db).s1).toMatchObject({ status: "host_offline" });
  });

  it("reads a starting session as stuck only once its last_seen is ten minutes old", async () => {
    const db = fakeDb({
      sessions: [
        session("fresh", { status: "starting", last_seen: "2026-11-18T09:58:00.000Z" }),
        session("stale", { status: "starting", last_seen: LONG_AGO }),
      ],
      agent_runs: [run("fresh"), run("stale")],
      session_inputs: [],
      errors: [],
    });
    const { provider } = fakeProvider({ states: { "machine-fresh": "missing", "machine-stale": "missing" } });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result.hostsLost).toBe(1);
    expect(byId(db).fresh).toMatchObject({ status: "starting" });
    expect(byId(db).stale).toMatchObject({ status: "sleeping" });
  });

  it("ignores live sessions, routine sessions, and sessions that are not cloud", async () => {
    const db = fakeDb({
      sessions: [
        session("live", { status: "live" }),
        session("routine", { status: "starting", session_type: "routine" }),
        session("local", { runtime: "local", status: "host_offline" }),
      ],
      agent_runs: [run("live"), run("routine"), run("local")],
      session_inputs: [],
      errors: [],
    });
    const { provider, statusCalls } = fakeProvider({ states: { "machine-live": "missing", "machine-routine": "missing", "machine-local": "missing" } });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result.hostsLost).toBe(0);
    expect(statusCalls).toEqual([]);
    expect(byId(db).live).toMatchObject({ status: "live" });
    expect(byId(db).routine).toMatchObject({ status: "starting" });
  });

  it("skips a session whose latest run already ended", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1", { status: "succeeded" })], session_inputs: [], errors: [] });
    const { provider, statusCalls } = fakeProvider({ states: { "machine-s1": "missing" } });

    expect((await reconcileCloudSessions(deps(db, provider))).hostsLost).toBe(0);
    expect(statusCalls).toEqual([]);
  });

  it("lets a lost session with an undelivered input wake, so the input is delivered", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1")], session_inputs: [input("s1", "queued")], errors: [] });
    const { provider } = fakeProvider({ states: { "machine-s1": "stopped" } });
    const wake = mock(async () => ({ status: "woken" }));

    const result = await reconcileCloudSessions(deps(db, provider, wake));

    expect(result.hostsLost).toBe(1);
    expect(wake).toHaveBeenCalledWith({ workspaceId: WS, sessionId: "s1" });
  });

  it("does not wake a lost session whose inputs were all taken", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1")], session_inputs: [input("s1", "consumed")], errors: [] });
    const { provider } = fakeProvider({ states: { "machine-s1": "missing" } });
    const wake = mock(async () => ({ status: "woken" }));

    await reconcileCloudSessions(deps(db, provider, wake));

    expect(wake).not.toHaveBeenCalled();
  });

  it("treats a run with no machine on record as having no machine, and does not ask Fly", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1", { sandbox_machine_id: null })], session_inputs: [], errors: [] });
    const { provider, statusCalls } = fakeProvider();

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result.hostsLost).toBe(1);
    expect(statusCalls).toEqual([]);
    expect(byId(db).s1).toMatchObject({ status: "sleeping" });
  });

  it("records a failed machine read, and keeps sweeping the other sessions", async () => {
    const db = fakeDb({
      sessions: [session("s1"), session("s2")],
      agent_runs: [run("s1"), run("s2")],
      session_inputs: [],
      errors: [],
    });
    const { provider } = fakeProvider({ states: { "machine-s2": "missing" }, statusFails: ["machine-s1"] });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result).toEqual({ hostsLost: 1, volumesDestroyed: 0, seedsRemoved: 0, failed: 1 });
    expect(byId(db).s1).toMatchObject({ status: "host_offline" });
    expect(runById(db, "run-s1")).toMatchObject({ status: "running" });
    expect(byId(db).s2).toMatchObject({ status: "sleeping" });
    const failure = errorRows(db).find((row) => row.session_id === "s1");
    expect(failure).toMatchObject({ agent_run_id: "run-s1" });
    expect(failure!.detail_json).toMatchObject({ code: "host_status_failed" });
  });

  it("records a failed run read for a stuck session, and sweeps on", async () => {
    const db = fakeDb({ sessions: [session("s1")], agent_runs: [run("s1")], session_inputs: [], errors: [] });
    const client = failingOn(fakeClient(db), "agent_runs", "runs down");
    const { provider } = fakeProvider({ states: { "machine-s1": "missing" } });

    const result = await reconcileCloudSessions({ ...deps(db, provider), client });

    expect(result).toEqual({ hostsLost: 0, volumesDestroyed: 0, seedsRemoved: 0, failed: 1 });
    expect(errorCodes(db)).toEqual(["host_run_lookup_failed"]);
  });
});

describe("reconcileCloudSessions: leaked volumes", () => {
  it("destroys the machine and volume of an ended session, then clears its volume ref", async () => {
    const db = fakeDb({
      sessions: [session("e1", { status: "ended", end_reason: "start_failed" })],
      agent_runs: [run("e1")],
      session_inputs: [],
      errors: [],
    });
    const { provider, destroyed } = fakeProvider();

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result).toEqual({ hostsLost: 0, volumesDestroyed: 1, seedsRemoved: 0, failed: 0 });
    expect(destroyed).toEqual([{ provider: "fly", machine: "machine-e1", volume: VOLUME_OF("e1") }]);
    expect(byId(db).e1).toMatchObject({ status: "ended", sandbox_volume: null });
    expect(errorRows(db)).toEqual([]);
  });

  it("destroys only the volume of an ended session with no machine on record", async () => {
    const db = fakeDb({
      sessions: [session("e1", { status: "ended" })],
      agent_runs: [run("e1", { sandbox_machine_id: null })],
      session_inputs: [],
      errors: [],
    });
    const { provider, destroyed } = fakeProvider();

    await reconcileCloudSessions(deps(db, provider));

    expect(destroyed).toEqual([{ provider: "fly", machine: "", volume: VOLUME_OF("e1") }]);
    expect(byId(db).e1).toMatchObject({ sandbox_volume: null });
  });

  it("records a failed destroy, keeps the volume ref, and destroys the next session", async () => {
    const db = fakeDb({
      sessions: [session("e1", { status: "ended" }), session("e2", { status: "ended" })],
      agent_runs: [run("e1"), run("e2")],
      session_inputs: [],
      errors: [],
    });
    const { provider, destroyed } = fakeProvider({ destroyFails: ["machine-e1"] });

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result).toEqual({ hostsLost: 0, volumesDestroyed: 1, seedsRemoved: 0, failed: 1 });
    expect(destroyed.map((ref) => ref.machine)).toEqual(["machine-e2"]);
    expect(byId(db).e1).toMatchObject({ sandbox_volume: VOLUME_OF("e1") });
    expect(byId(db).e2).toMatchObject({ sandbox_volume: null });
    expect(errorRows(db)[0]).toMatchObject({ session_id: "e1", operation: "execution" });
    expect(errorRows(db)[0]!.detail_json).toMatchObject({ code: "sandbox_destroy_failed", volume_id: "vol-e1" });
  });

  it("records a volume ref that is not valid, and destroys nothing for it", async () => {
    const db = fakeDb({
      sessions: [session("e1", { status: "ended", sandbox_volume: { provider: "fly" } })],
      agent_runs: [run("e1")],
      session_inputs: [],
      errors: [],
    });
    const { provider, destroyed } = fakeProvider();

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result).toEqual({ hostsLost: 0, volumesDestroyed: 0, seedsRemoved: 0, failed: 1 });
    expect(destroyed).toEqual([]);
    expect(errorCodes(db)).toEqual(["sandbox_volume_invalid"]);
  });

  it("leaves sessions without a volume, and sleeping sessions, to their own paths", async () => {
    const db = fakeDb({
      sessions: [
        session("none", { status: "ended", sandbox_volume: null }),
        session("asleep", { status: "sleeping" }),
      ],
      agent_runs: [run("none"), run("asleep")],
      session_inputs: [],
      errors: [],
    });
    const { provider, destroyed } = fakeProvider();

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result).toEqual({ hostsLost: 0, volumesDestroyed: 0, seedsRemoved: 0, failed: 0 });
    expect(destroyed).toEqual([]);
    expect(byId(db).asleep).toMatchObject({ status: "sleeping", sandbox_volume: VOLUME_OF("asleep") });
  });

  it("takes at most 50 ended sessions per sweep", async () => {
    const ids = Array.from({ length: 52 }, (_, index) => `e${String(index).padStart(2, "0")}`);
    const db = fakeDb({
      sessions: ids.map((id) => session(id, { status: "ended" })),
      agent_runs: ids.map((id) => run(id)),
      session_inputs: [],
      errors: [],
    });
    const { provider, destroyed } = fakeProvider();

    const result = await reconcileCloudSessions(deps(db, provider));

    expect(result.volumesDestroyed).toBe(50);
    expect(destroyed).toHaveLength(50);
    expect(db.tables.sessions!.filter((row) => row.sandbox_volume !== null)).toHaveLength(2);
  });
});

describe("reconcileCloudSessions: folder snapshots no session needs", () => {
  const KEY = (id: string) => `${WS}/${id}/seed.tar.gz`;
  /** The snapshot store the sweep deletes from. A key in `failing` makes its delete throw. */
  function snapshots(failing = false) {
    const removed: string[][] = [];
    return {
      removed,
      store: {
        exists: async () => true,
        downloadUrl: async () => "unused",
        remove: async (keys: string[]) => {
          if (failing) throw new Error("storage 503");
          removed.push(keys);
        },
      },
    };
  }
  /** The sweep's query returns the names it is given, and records the arguments it was called with. */
  function stale(db: FakeDb, names: string[]) {
    const calls: Array<Record<string, unknown>> = [];
    db.rpcs.list_stale_session_seeds = (args) => {
      calls.push(args);
      return { data: names.map((object_name) => ({ object_name })), error: null };
    };
    return calls;
  }

  it("deletes the snapshots the database names, and asks for them a batch at a time, a day past the orphan cutoff", async () => {
    const db = fakeDb({ sessions: [], agent_runs: [], errors: [] });
    const calls = stale(db, [KEY("s1"), KEY("s2")]);
    const store = snapshots();

    const result = await reconcileCloudSessions({ ...deps(db, fakeProvider().provider), snapshots: store.store });

    expect(calls).toEqual([{ p_orphan_before: "2026-11-17T10:00:00.000Z", p_limit: 50 }]);
    expect(store.removed).toEqual([[KEY("s1"), KEY("s2")]]);
    expect(result).toEqual({ hostsLost: 0, volumesDestroyed: 0, seedsRemoved: 2, failed: 0 });
  });

  it("deletes nothing and touches no storage when the database names no snapshot", async () => {
    const db = fakeDb({ sessions: [], agent_runs: [], errors: [] });
    stale(db, []);
    const store = snapshots();

    const result = await reconcileCloudSessions({ ...deps(db, fakeProvider().provider), snapshots: store.store });

    expect(store.removed).toEqual([]);
    expect(result.seedsRemoved).toBe(0);
  });

  it("records a failed listing and a failed delete, and reports each as a failure", async () => {
    const listing = fakeDb({ sessions: [], agent_runs: [], errors: [] });
    listing.rpcs.list_stale_session_seeds = () => ({ data: null, error: { message: "rpc down" } });
    const listed = await reconcileCloudSessions({ ...deps(listing, fakeProvider().provider), snapshots: snapshots().store });
    expect(listed.failed).toBe(1);
    expect(errorCodes(listing)).toEqual(["seed_sweep_failed"]);

    const deleting = fakeDb({ sessions: [], agent_runs: [], errors: [] });
    stale(deleting, [KEY("s1")]);
    const removed = await reconcileCloudSessions({ ...deps(deleting, fakeProvider().provider), snapshots: snapshots(true).store });
    expect(removed).toMatchObject({ seedsRemoved: 0, failed: 1 });
    expect(errorCodes(deleting)).toEqual(["seed_sweep_remove_failed"]);
  });
});
