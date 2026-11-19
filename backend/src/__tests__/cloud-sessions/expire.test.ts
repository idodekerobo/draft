import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLOUD_SESSION_EXPIRY_MS, expireIdleCloudSessions } from "../../cloud-sessions/expire";
import type { SandboxProvider, SandboxRef } from "../../metaharness/sandbox/providers";

type Row = Record<string, unknown>;

interface FakeState {
  tables: Record<string, Row[]>;
  /** Runs after a select has its rows, so a test can change the database between the read and the claim. */
  onRead?: (table: string) => void;
  /** Makes the query fail when it returns true. */
  failWhen?: (table: string, operation: "select" | "update" | "insert") => boolean;
}

const WS = "workspace-1";
const NOW = new Date("2026-11-18T10:00:00.000Z");
const IDLE = "2026-10-01T00:00:00.000Z";
const FRESH = "2026-11-17T09:00:00.000Z";
const CUTOFF = new Date(NOW.getTime() - CLOUD_SESSION_EXPIRY_MS).toISOString();

function volumeOf(id: string) {
  return { provider: "fly", id: `vol-${id}`, region: "iad" };
}

function session(id: string, overrides: Row = {}): Row {
  return {
    id,
    workspace_id: WS,
    runtime: "cloud",
    status: "sleeping",
    last_event_at: IDLE,
    deleted_at: null,
    sandbox_volume: volumeOf(id),
    end_reason: null,
    ended_at: null,
    ...overrides,
  };
}

function run(sessionId: string, machine: string | null, createdAt = "2026-09-30T00:00:00.000Z"): Row {
  return { id: `run-${sessionId}-${createdAt}`, session_id: sessionId, sandbox_machine_id: machine, created_at: createdAt };
}

function compare(a: unknown, b: unknown): number {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Supports the filters, ordering and limit the sweep uses. A query runs when it is awaited. */
class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Array<(row: Row) => boolean> = [];
  private operation: "select" | "update" | "insert" = "select";
  private values: Row = {};
  private sort: { column: string; ascending: boolean } | null = null;
  private cap = Infinity;

  constructor(private readonly table: string, private readonly state: FakeState) {}

  select() {
    return this;
  }
  update(values: Row) {
    this.operation = "update";
    this.values = values;
    return this;
  }
  insert(values: Row) {
    this.operation = "insert";
    this.values = values;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  lt(column: string, value: string) {
    this.filters.push((row) => typeof row[column] === "string" && (row[column] as string) < value);
    return this;
  }
  is(column: string, value: null) {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }
  not(column: string, _operator: "is", value: null) {
    this.filters.push((row) => (row[column] ?? null) !== value);
    return this;
  }
  order(column: string, options: { ascending: boolean }) {
    this.sort = { column, ascending: options.ascending };
    return this;
  }
  limit(count: number) {
    this.cap = count;
    return this;
  }
  maybeSingle() {
    return this.execute().then((result) => ({ data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data, error: result.error }));
  }
  then<T1, T2>(onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null) {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<{ data: unknown; error: unknown }> {
    if (this.state.failWhen?.(this.table, this.operation)) {
      return { data: null, error: new Error(`${this.table} ${this.operation} failed`) };
    }
    const rows = (this.state.tables[this.table] ??= []);
    if (this.operation === "insert") {
      rows.push({ ...this.values });
      return { data: null, error: null };
    }
    let matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.sort) {
      const { column, ascending } = this.sort;
      matched = [...matched].sort((a, b) => compare(a[column], b[column]) * (ascending ? 1 : -1));
    }
    matched = matched.slice(0, this.cap);
    if (this.operation === "update") {
      for (const row of matched) Object.assign(row, this.values);
      return { data: matched, error: null };
    }
    this.state.onRead?.(this.table);
    return { data: matched, error: null };
  }
}

function fakeSupabase(state: FakeState): SupabaseClient {
  return { from: (table: string) => new FakeQuery(table, state) } as unknown as SupabaseClient;
}

/** A provider whose destroy records each machine it deletes. A machine in `failing` makes destroy throw. */
function fakeProvider(failing: string[] = []) {
  const destroyed: SandboxRef[] = [];
  const provider: SandboxProvider = {
    async create() {
      throw new Error("not used by the expiry sweep");
    },
    async start() {
      throw new Error("not used by the expiry sweep");
    },
    async stop() {
      throw new Error("not used by the expiry sweep");
    },
    async destroy(ref) {
      if (failing.includes(ref.machine)) throw new Error("Fly is unavailable");
      destroyed.push(ref);
    },
    async destroyMachine() {
      throw new Error("not used by the expiry sweep");
    },
    async status() {
      throw new Error("not used by the expiry sweep");
    },
  };
  return { provider, destroyed };
}

function state(sessions: Row[], runs: Row[] = []): FakeState {
  return { tables: { sessions, agent_runs: runs, errors: [] } };
}

describe("expireIdleCloudSessions", () => {
  it("destroys the sandbox of an idle sleeping session, then ends it and clears its volume", async () => {
    const db = state([session("s1")], [run("s1", "machine-s1")]);
    const { provider, destroyed } = fakeProvider();

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result).toEqual({ expired: 1, skipped: 0, failed: 0 });
    expect(destroyed).toEqual([{ provider: "fly", machine: "machine-s1", volume: volumeOf("s1") }]);
    expect(db.tables.sessions[0]).toMatchObject({
      status: "ended",
      end_reason: "expired",
      ended_at: NOW.toISOString(),
      sandbox_volume: null,
    });
    expect(db.tables.errors).toEqual([]);
  });

  it("destroys the machine of the newest run that recorded one", async () => {
    const db = state(
      [session("s1")],
      [
        run("s1", "machine-old", "2026-09-01T00:00:00.000Z"),
        run("s1", "machine-new", "2026-09-20T00:00:00.000Z"),
        run("s1", null, "2026-10-01T00:00:00.000Z"),
      ],
    );
    const { provider, destroyed } = fakeProvider();

    await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(destroyed.map((ref) => ref.machine)).toEqual(["machine-new"]);
  });

  it("leaves fresh, live, local, deleted and boundary sessions untouched", async () => {
    const db = state(
      [
        session("idle"),
        session("fresh", { last_event_at: FRESH }),
        session("boundary", { last_event_at: CUTOFF }),
        session("live", { status: "live" }),
        session("local", { runtime: "local", sandbox_volume: null }),
        session("deleted", { deleted_at: "2026-10-02T00:00:00.000Z" }),
      ],
      ["idle", "fresh", "boundary", "live", "local", "deleted"].map((id) => run(id, `machine-${id}`)),
    );
    const { provider, destroyed } = fakeProvider();

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result).toEqual({ expired: 1, skipped: 0, failed: 0 });
    expect(destroyed.map((ref) => ref.machine)).toEqual(["machine-idle"]);
    const byId = Object.fromEntries(db.tables.sessions.map((row) => [row.id, row]));
    expect(byId.fresh).toMatchObject({ status: "sleeping", sandbox_volume: volumeOf("fresh") });
    expect(byId.boundary).toMatchObject({ status: "sleeping" });
    expect(byId.live).toMatchObject({ status: "live" });
    expect(byId.deleted).toMatchObject({ status: "sleeping" });
  });

  it("records a destroy failure against its session, keeps the volume ref, and still expires the next session", async () => {
    const db = state([session("s1"), session("s2")], [run("s1", "machine-s1"), run("s2", "machine-s2")]);
    const { provider, destroyed } = fakeProvider(["machine-s1"]);

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result).toEqual({ expired: 1, skipped: 0, failed: 1 });
    expect(destroyed.map((ref) => ref.machine)).toEqual(["machine-s2"]);
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors[0]).toMatchObject({
      workspace_id: WS,
      session_id: "s1",
      operation: "execution",
    });
    expect(db.tables.errors[0]!.detail_json).toMatchObject({ code: "sandbox_destroy_failed", volume_id: "vol-s1" });
    const byId = Object.fromEntries(db.tables.sessions.map((row) => [row.id, row]));
    expect(byId.s1).toMatchObject({ status: "ended", end_reason: "expired", sandbox_volume: volumeOf("s1") });
    expect(byId.s2).toMatchObject({ status: "ended", sandbox_volume: null });
  });

  it("leaves a session that woke after the read untouched, and destroys nothing", async () => {
    const db = state([session("s1")], [run("s1", "machine-s1")]);
    // A wake lands between the machine lookup and the claim.
    db.onRead = (table) => {
      if (table === "agent_runs") db.tables.sessions[0]!.status = "starting";
    };
    const { provider, destroyed } = fakeProvider();

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result).toEqual({ expired: 0, skipped: 1, failed: 0 });
    expect(destroyed).toEqual([]);
    expect(db.tables.sessions[0]).toMatchObject({ status: "starting", end_reason: null, sandbox_volume: volumeOf("s1") });
    expect(db.tables.errors).toEqual([]);
  });

  it("records a session with no machine on any run, and leaves it sleeping", async () => {
    const db = state([session("s1")], [run("s1", null)]);
    const { provider, destroyed } = fakeProvider();

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result).toEqual({ expired: 0, skipped: 0, failed: 1 });
    expect(destroyed).toEqual([]);
    expect(db.tables.sessions[0]).toMatchObject({ status: "sleeping" });
    expect(db.tables.errors[0]!.detail_json).toMatchObject({ code: "sandbox_machine_missing" });
  });

  it("records a session with no valid volume ref, and leaves it sleeping", async () => {
    const db = state([session("s1", { sandbox_volume: null })], [run("s1", "machine-s1")]);
    const { provider, destroyed } = fakeProvider();

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result).toEqual({ expired: 0, skipped: 0, failed: 1 });
    expect(destroyed).toEqual([]);
    expect(db.tables.sessions[0]).toMatchObject({ status: "sleeping" });
    expect(db.tables.errors[0]!.detail_json).toMatchObject({ code: "sandbox_volume_invalid" });
  });

  it("records a failed claim and destroys nothing", async () => {
    const db = state([session("s1")], [run("s1", "machine-s1")]);
    db.failWhen = (table, operation) => table === "sessions" && operation === "update";
    const { provider, destroyed } = fakeProvider();

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result).toEqual({ expired: 0, skipped: 0, failed: 1 });
    expect(destroyed).toEqual([]);
    expect(db.tables.sessions[0]).toMatchObject({ status: "sleeping" });
    expect(db.tables.errors[0]).toMatchObject({ session_id: "s1", operation: "session" });
    expect(db.tables.errors[0]!.detail_json).toMatchObject({ code: "session_expire_failed" });
  });

  it("throws when the sweep query fails, so the tick records it", async () => {
    const db = state([session("s1")], [run("s1", "machine-s1")]);
    db.failWhen = (table, operation) => table === "sessions" && operation === "select";
    const { provider } = fakeProvider();

    await expect(expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW })).rejects.toThrow("sessions select failed");
  });

  it("takes at most 50 sessions per sweep, oldest idle first", async () => {
    const ids = Array.from({ length: 52 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    const db = state(
      ids.map((id, index) => session(id, { last_event_at: new Date(Date.parse(IDLE) + index * 3_600_000).toISOString() })),
      ids.map((id) => run(id, `machine-${id}`)),
    );
    const { provider, destroyed } = fakeProvider();

    const result = await expireIdleCloudSessions({ client: fakeSupabase(db), provider, now: () => NOW });

    expect(result.expired).toBe(50);
    expect(destroyed.map((ref) => ref.machine)).toEqual(ids.slice(0, 50).map((id) => `machine-${id}`));
    expect(db.tables.sessions.filter((row) => row.status === "sleeping").map((row) => row.id)).toEqual(["s50", "s51"]);
  });
});
