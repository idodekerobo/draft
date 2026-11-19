import { beforeEach, describe, expect, it } from "bun:test";
import type { CloudSessionDeps } from "../../cloud-sessions/launch";
import { RESTART_LIMIT, wakeCloudSession } from "../../cloud-sessions/wake";
import type { SnapshotStore } from "../../cloud-sessions/snapshot-seed";
import type { SandboxDeploymentConfig } from "../../metaharness/sandbox/config";
import type { SandboxProvider, SandboxRef, SandboxSpec } from "../../metaharness/sandbox/providers";
import { verifyAgentRunToken } from "../../metaharness/runs/run-token";
import { CredentialError } from "../../credentials/crypto";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

type Row = Record<string, unknown>;

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "66666666-6666-4666-8666-666666666666";
const VERSION = "44444444-4444-4444-8444-444444444444";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN_OLDEST = "10000000-0000-4000-8000-000000000001";
const RUN_MIDDLE = "10000000-0000-4000-8000-000000000002";
const RUN_LATEST = "10000000-0000-4000-8000-000000000003";
const RUN_ACTIVE = "10000000-0000-4000-8000-000000000004";
const NONCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "wake-test-secret";
const CLAUDE_TOKEN = "sk-ant-oat-claude-login-test";
const NOW = Date.parse("2026-11-18T10:00:00.000Z");
const VOLUME = { provider: "fly", id: "vol-1", region: "iad" };
const OLD_MACHINE = "machine-old";
const NEW_MACHINE = "machine-new";
const ACTIVE = ["queued", "preparing", "running", "validating", "committing"];
const INPUT = { workspaceId: WS, sessionId: SESSION };

const config: SandboxDeploymentConfig = {
  callbackUrl: "https://api.draft.test/sandbox/callback",
  callbackSecret: SECRET,
  supabaseUrl: "https://project.supabase.co",
  provider: { kind: "fly", apiToken: "fly-token", appName: "draft-sandbox", image: `registry.fly.io/draft-sandbox@sha256:${"a".repeat(64)}`, region: "iad" },
};

function sleepingSession(overrides: Row = {}): Row {
  return {
    id: SESSION,
    workspace_id: WS,
    owner_user_id: OWNER,
    runtime: "cloud",
    status: "sleeping",
    model: "haiku",
    reasoning_effort: null,
    git_remote: "https://github.com/acme/app.git",
    seed: { kind: "repo", branch: "main" },
    sandbox_volume: VOLUME,
    host_id: `cloud:${SESSION}`,
    deleted_at: null,
    ...overrides,
  };
}

/** A run of the session with a spec the store can read back. The defaults are a run that succeeded on the old machine. */
function run(overrides: Row = {}): Row {
  return {
    id: OLD_RUN,
    workspace_id: WS,
    session_id: SESSION,
    kind: "interactive",
    trigger: { type: "manual", requestedBy: OWNER },
    on_behalf_of_user_id: null,
    runtime: { type: "cloud", toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] }, network: "restricted" },
    harness: "claude",
    model: "haiku",
    reasoning_effort: null,
    instructions: "",
    base_context_version_id: VERSION,
    permissions: [],
    output: { type: "text" },
    status: "succeeded",
    sandbox_machine_id: OLD_MACHINE,
    created_at: "2026-11-18T09:00:00.000Z",
    ...overrides,
  };
}

/** The most recent runs of a session that all failed, one per restart. */
function failedRuns(count = RESTART_LIMIT): Row[] {
  return Array.from({ length: count }, (_, index) => run({ id: crypto.randomUUID(), status: "failed", created_at: `2026-11-18T0${index + 6}:00:00.000Z` }));
}

/** A fake database that enforces the one-active-run index and the claim function, as Postgres does. */
function newDb(tables: Record<string, Row[]> = {}): FakeDb {
  const db = fakeDb(
    {
      workspaces: [{ id: WS, timezone: "UTC", current_context_version_id: VERSION }],
      sessions: [sleepingSession()],
      agent_runs: [run()],
      session_inputs: [],
      errors: [],
      ...tables,
    },
    {
      unique: {
        sessions: [["id"]],
        agent_runs: [
          ["workspace_id", "idempotency_key"],
          { name: "agent_runs_one_active_per_session", columns: ["session_id"], where: (row) => ACTIVE.includes(row.status as string) },
        ],
      },
    },
  );
  db.rpcs.claim_cloud_session_wake = (args) => {
    const row = db.tables.sessions!.find(
      (s) => s.id === args.p_session_id && s.workspace_id === args.p_workspace_id && s.runtime === "cloud" && s.status === "sleeping" && s.deleted_at == null,
    );
    if (!row) return { data: false };
    row.status = "starting";
    return { data: true };
  };
  return db;
}

let db: FakeDb;

beforeEach(() => {
  db = newDb();
});

/** A provider that records its calls. The status option is what the machine reports; each failure is thrown by its step. */
function fakeProvider(options: { status?: "running" | "stopped" | "missing"; failures?: { status?: Error; create?: Error; start?: Error; destroyMachine?: Error } } = {}) {
  const calls: string[] = [];
  const created: SandboxSpec[] = [];
  const removed: SandboxRef[] = [];
  const failures = options.failures ?? {};
  const provider: SandboxProvider = {
    async create(spec) {
      calls.push("create");
      if (failures.create) throw failures.create;
      created.push(spec);
      const volume = spec.volume && "existing" in spec.volume ? spec.volume.existing : null;
      return { provider: "fly", machine: NEW_MACHINE, volume };
    },
    async start(ref) {
      calls.push(`start ${ref.machine}`);
      if (failures.start) throw failures.start;
    },
    async stop() {
      calls.push("stop");
    },
    async destroy(ref) {
      calls.push(`destroy ${ref.machine}`);
    },
    async destroyMachine(ref) {
      calls.push(`destroyMachine ${ref.machine}`);
      removed.push(ref);
      if (failures.destroyMachine) throw failures.destroyMachine;
    },
    async status(ref) {
      calls.push(`status ${ref.machine}`);
      if (failures.status) throw failures.status;
      return options.status ?? "stopped";
    },
  };
  return { provider, calls, created, removed };
}

/** The deps a wake gets. The run ids come from a fixed list, so a test knows which row is the new run. */
function depsFor(provider: SandboxProvider, overrides: Partial<CloudSessionDeps> = {}): CloudSessionDeps {
  const ids = [NEW_RUN, NONCE];
  return {
    client: fakeClient(db),
    provider,
    config,
    tokenSecret: SECRET,
    resolveCredential: async () => ({ credentialId: "cred-1", secret: CLAUDE_TOKEN }),
    now: () => NOW,
    newId: () => ids.shift() ?? crypto.randomUUID(),
    ...overrides,
  };
}

const session = () => db.tables.sessions![0]!;
const runById = (id: string) => db.tables.agent_runs!.find((row) => row.id === id);
const errorCodes = () => db.tables.errors!.map((row) => (row.detail_json as { code?: string }).code);

describe("wakeCloudSession", () => {
  it("replaces a stopped machine with a new one on the same volume, under a fresh run token", async () => {
    const fly = fakeProvider({ status: "stopped" });
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "woken", runId: NEW_RUN });
    expect(fly.calls).toEqual([`status ${OLD_MACHINE}`, `destroyMachine ${OLD_MACHINE}`, "create", `start ${NEW_MACHINE}`]);
    expect(fly.removed).toEqual([{ provider: "fly", machine: OLD_MACHINE, volume: VOLUME }]);
    expect(fly.created[0]).toMatchObject({ runId: NEW_RUN, volume: { existing: VOLUME }, metadata: { session_id: SESSION, run_id: NEW_RUN, kind: "cloud_session" } });

    const env = fly.created[0]!.env;
    expect(env).toMatchObject({ DRAFT_RUN_ID: NEW_RUN, DRAFT_SESSION_ID: SESSION, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN, DRAFT_NETWORK: "restricted" });
    expect(verifyAgentRunToken(env.DRAFT_RUN_TOKEN!, SECRET, { now: NOW })).toMatchObject({ runId: NEW_RUN, workspaceId: WS, scope: "host" });
    expect(verifyAgentRunToken(env.DRAFT_MCP_TOKEN!, SECRET, { now: NOW })).toMatchObject({ runId: NEW_RUN, workspaceId: WS, scope: "mcp" });

    expect(session()).toMatchObject({ status: "starting" });
    expect(runById(NEW_RUN)).toMatchObject({
      status: "running",
      session_id: SESSION,
      kind: "interactive",
      sandbox_machine_id: NEW_MACHINE,
      model: "haiku",
      idempotency_key: `cloud-session:${SESSION}:${NEW_RUN}`,
      trigger: { type: "manual", requestedBy: OWNER },
    });
    expect(errorCodes()).toEqual([]);
  });

  it("replaces a machine that is still running, and records the anomaly on the new run", async () => {
    const fly = fakeProvider({ status: "running" });
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "woken", runId: NEW_RUN });
    expect(fly.removed).toEqual([{ provider: "fly", machine: OLD_MACHINE, volume: VOLUME }]);
    expect(errorCodes()).toEqual(["sandbox_running_on_wake"]);
    expect(db.tables.errors![0]).toMatchObject({ agent_run_id: NEW_RUN, session_id: SESSION });
  });

  it("does not remove a missing machine, and mounts the kept volume on a new one", async () => {
    const fly = fakeProvider({ status: "missing" });
    await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(fly.calls).toEqual([`status ${OLD_MACHINE}`, "create", `start ${NEW_MACHINE}`]);
    expect(fly.removed).toEqual([]);
    expect(fly.created[0]!.volume).toEqual({ existing: VOLUME });
  });

  it("creates a machine on the volume when the last run recorded none", async () => {
    db.tables.agent_runs = [run({ sandbox_machine_id: null })];
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "woken", runId: NEW_RUN });
    expect(fly.calls).toEqual(["create", `start ${NEW_MACHINE}`]);
  });

  it("keeps the network of the session's last run", async () => {
    db.tables.agent_runs = [run({ runtime: { type: "cloud", toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] }, network: "open" } })];
    const fly = fakeProvider({ status: "missing" });
    await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(fly.created[0]!.env.DRAFT_NETWORK).toBe("open");
    expect((runById(NEW_RUN)!.runtime as { network: string }).network).toBe("open");
  });

  it("starts one run when two wakes race for the same sleeping session", async () => {
    const fly = fakeProvider({ status: "missing" });
    const deps = depsFor(fly.provider);
    const outcomes = await Promise.all([wakeCloudSession(INPUT, deps), wakeCloudSession(INPUT, deps)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["not_claimed", "woken"]);
    expect(db.rpcCalls.filter((call) => call.name === "claim_cloud_session_wake")).toHaveLength(2);
    expect(db.tables.agent_runs!.filter((row) => row.session_id === SESSION && row.status === "running")).toHaveLength(1);
    expect(fly.created).toHaveLength(1);
  });

  it("does nothing to a session that is not sleeping", async () => {
    db.tables.sessions = [sleepingSession({ status: "live" })];
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "not_claimed" });
    expect(fly.calls).toEqual([]);
    expect(db.tables.agent_runs).toHaveLength(1);
  });

  it("ends the session when its last runs all failed, and fails the messages queued for the wake", async () => {
    db.tables.agent_runs = failedRuns();
    db.tables.session_inputs = [{ id: "input-1", session_id: SESSION, workspace_id: WS, kind: "message", state: "queued" }];
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "ended" });
    expect(session()).toMatchObject({ status: "ended", end_reason: "start_failed" });
    expect(db.tables.session_inputs![0]).toMatchObject({ state: "failed", reason: "session_ended" });
    expect(db.tables.agent_runs).toHaveLength(RESTART_LIMIT);
    expect(fly.calls).toEqual([]);
    expect(errorCodes()).toEqual(["restart_limit_reached"]);
  });

  it("keeps waking a session when one of its last runs succeeded", async () => {
    db.tables.agent_runs = [
      run({ id: RUN_OLDEST, status: "failed", created_at: "2026-11-18T07:00:00.000Z" }),
      run({ id: RUN_MIDDLE, status: "succeeded", created_at: "2026-11-18T08:00:00.000Z" }),
      run({ id: RUN_LATEST, status: "failed", created_at: "2026-11-18T09:00:00.000Z" }),
    ];
    const outcome = await wakeCloudSession(INPUT, depsFor(fakeProvider({ status: "missing" }).provider));

    expect(outcome).toEqual({ status: "woken", runId: NEW_RUN });
  });

  it("keeps waking a session whose recent runs were refused, since refused wakes do not count", async () => {
    db.tables.agent_runs = [
      run({ id: RUN_OLDEST, status: "failed", created_at: "2026-11-18T06:00:00.000Z" }),
      run({ id: RUN_MIDDLE, status: "failed", created_at: "2026-11-18T07:00:00.000Z" }),
      run({ id: crypto.randomUUID(), status: "failed", failure_code: "claude_not_connected", created_at: "2026-11-18T08:00:00.000Z" }),
      run({ id: crypto.randomUUID(), status: "failed", failure_code: "claude_not_connected", created_at: "2026-11-18T09:00:00.000Z" }),
    ];
    const fly = fakeProvider({ status: "missing" });
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "woken", runId: NEW_RUN });
    expect(errorCodes()).toEqual([]);
  });

  it("ends the session when its last real failures sit behind refused wakes", async () => {
    db.tables.agent_runs = [
      run({ id: RUN_OLDEST, status: "failed", created_at: "2026-11-18T06:00:00.000Z" }),
      run({ id: crypto.randomUUID(), status: "failed", failure_code: "claude_not_connected", created_at: "2026-11-18T07:00:00.000Z" }),
      run({ id: RUN_MIDDLE, status: "failed", created_at: "2026-11-18T08:00:00.000Z" }),
      run({ id: crypto.randomUUID(), status: "failed", failure_code: "claude_not_connected", created_at: "2026-11-18T09:00:00.000Z" }),
      run({ id: RUN_LATEST, status: "failed", created_at: "2026-11-18T09:30:00.000Z" }),
    ];
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "ended" });
    expect(fly.calls).toEqual([]);
    expect(errorCodes()).toEqual(["restart_limit_reached"]);
  });

  it("fails the run as a refusal when the workspace has no Claude login, and records no error", async () => {
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(
      INPUT,
      depsFor(fly.provider, { resolveCredential: async () => { throw new CredentialError("Workspace has no Claude Code login", "missing"); } }),
    );

    expect(outcome).toEqual({ status: "failed" });
    expect(fly.calls).toEqual([]);
    expect(runById(NEW_RUN)).toMatchObject({ status: "failed", failure_code: "claude_not_connected" });
    expect(session()).toMatchObject({ status: "sleeping" });
    expect(errorCodes()).toEqual([]);
  });

  it("refuses a second active run for the session in the database, records it, and sleeps the session again", async () => {
    db.tables.agent_runs!.push(run({ id: RUN_ACTIVE, status: "running", created_at: "2026-11-18T09:30:00.000Z" }));
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "failed" });
    expect(runById(NEW_RUN)).toBeUndefined();
    expect(fly.calls).toEqual([]);
    expect(errorCodes()).toEqual(["run_create_failed"]);
    expect(db.tables.errors![0]).toMatchObject({ agent_run_id: null, session_id: SESSION });
    expect(session()).toMatchObject({ status: "sleeping" });
  });

  it("fails the wake and sleeps the session when the old machine cannot be removed", async () => {
    const fly = fakeProvider({ status: "stopped", failures: { destroyMachine: new Error("fly 500") } });
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "failed" });
    expect(fly.calls).toEqual([`status ${OLD_MACHINE}`, `destroyMachine ${OLD_MACHINE}`]);
    expect(errorCodes()).toEqual(["sandbox_replace_failed"]);
    expect(runById(NEW_RUN)).toMatchObject({ status: "failed", failure_code: "sandbox_replace_failed" });
    expect(session()).toMatchObject({ status: "sleeping" });
  });

  it("fails the wake when the machine status cannot be read", async () => {
    const fly = fakeProvider({ failures: { status: new Error("fly 503") } });
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "failed" });
    expect(fly.calls).toEqual([`status ${OLD_MACHINE}`]);
    expect(errorCodes()).toEqual(["sandbox_replace_failed"]);
    expect(session()).toMatchObject({ status: "sleeping" });
  });

  it("fails the wake when the new machine cannot be created, and sleeps the session", async () => {
    const fly = fakeProvider({ status: "missing", failures: { create: new Error("volume not found") } });
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "failed" });
    expect(fly.removed).toEqual([]);
    expect(errorCodes()).toEqual(["sandbox_create_failed"]);
    expect(runById(NEW_RUN)).toMatchObject({ status: "failed", failure_code: "sandbox_create_failed" });
    expect(session()).toMatchObject({ status: "sleeping", sandbox_volume: VOLUME });
  });

  it("removes the new machine when it does not start, fails the run, and sleeps the session without leaking the login", async () => {
    const fly = fakeProvider({ status: "missing", failures: { start: new Error("machine did not boot") } });
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "failed" });
    expect(fly.calls).toEqual([`status ${OLD_MACHINE}`, "create", `start ${NEW_MACHINE}`, `destroyMachine ${NEW_MACHINE}`]);
    expect(fly.removed).toEqual([{ provider: "fly", machine: NEW_MACHINE, volume: VOLUME }]);
    expect(errorCodes()).toEqual(["sandbox_start_failed"]);
    expect(runById(NEW_RUN)).toMatchObject({ status: "failed", failure_code: "sandbox_start_failed", sandbox_machine_id: NEW_MACHINE });
    expect(session()).toMatchObject({ status: "sleeping", sandbox_volume: VOLUME });
    expect(JSON.stringify(db.tables.errors)).not.toContain(CLAUDE_TOKEN);
  });

  it("records a claim that fails, and changes nothing else", async () => {
    db.rpcs.claim_cloud_session_wake = () => ({ data: null, error: { message: "connection reset" } });
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "failed" });
    expect(errorCodes()).toEqual(["wake_claim_failed"]);
    expect(session()).toMatchObject({ status: "sleeping" });
    expect(db.tables.agent_runs).toHaveLength(1);
    expect(fly.calls).toEqual([]);
  });

  it("fails the wake when the session has no sandbox volume to wake on", async () => {
    db.tables.sessions = [sleepingSession({ sandbox_volume: null })];
    const fly = fakeProvider();
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider));

    expect(outcome).toEqual({ status: "failed" });
    expect(errorCodes()).toEqual(["sandbox_volume_missing"]);
    expect(fly.calls).toEqual([]);
    expect(session()).toMatchObject({ status: "sleeping" });
  });
});

const SNAPSHOT_KEY = `${WS}/${SESSION}/seed.tar.gz`;

describe("wakeCloudSession from a folder snapshot", () => {
  /** A store that signs a new link on each call, so each launch's link can be told apart. */
  function linkStore(objects = [SNAPSHOT_KEY]) {
    const signed: string[] = [];
    const store: SnapshotStore = {
      exists: async (key) => objects.includes(key),
      downloadUrl: async (key) => {
        const url = `https://project.supabase.co/storage/v1/object/sign/session-seeds/${key}?token=${signed.length + 1}`;
        signed.push(url);
        return url;
      },
    };
    return { store, signed };
  }

  beforeEach(() => {
    db.tables.sessions = [sleepingSession({ git_remote: null, folder_name: "marigold", seed: { kind: "snapshot", storageKey: SNAPSHOT_KEY } })];
  });

  it("rebuilds the download link on every wake, so a later wake gets a link that has not expired", async () => {
    const links = linkStore();
    const first = fakeProvider({ status: "stopped" });
    expect(await wakeCloudSession(INPUT, depsFor(first.provider, { snapshots: links.store }))).toEqual({ status: "woken", runId: NEW_RUN });
    expect(first.created[0]!.env.DRAFT_SEED).toBe(JSON.stringify({ kind: "snapshot", url: links.signed[0] }));

    // The first wake's run has to finish before the session can sleep and wake again.
    runById(NEW_RUN)!.status = "succeeded";
    db.tables.sessions![0]!.status = "sleeping";
    const second = fakeProvider({ status: "stopped" });
    const LATER_RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(await wakeCloudSession(INPUT, depsFor(second.provider, { snapshots: links.store, newId: () => LATER_RUN }))).toEqual({ status: "woken", runId: LATER_RUN });
    expect(second.created[0]!.env.DRAFT_SEED).toBe(JSON.stringify({ kind: "snapshot", url: links.signed[1] }));
    expect(links.signed).toHaveLength(2);
    expect(links.signed[0]).not.toBe(links.signed[1]);
  });

  it("runs the new run with no GitHub credential", async () => {
    await wakeCloudSession(INPUT, depsFor(fakeProvider({ status: "stopped" }).provider, { snapshots: linkStore().store }));
    const names = (runById(NEW_RUN)!.permissions as Array<{ tool: string }>).map((p) => p.tool);
    expect(names).not.toContain("github.credential");
  });

  it("fails the wake, and sleeps the session again, when the download link cannot be made", async () => {
    const fly = fakeProvider({ status: "stopped" });
    const failing: SnapshotStore = {
      exists: async () => true,
      downloadUrl: async () => { throw new Error("sign failed"); },
    };
    const outcome = await wakeCloudSession(INPUT, depsFor(fly.provider, { snapshots: failing }));

    expect(outcome).toEqual({ status: "failed" });
    expect(errorCodes()).toEqual(["snapshot_link_failed"]);
    expect(fly.calls).toEqual([]);
    expect(session()).toMatchObject({ status: "sleeping" });
  });
});
