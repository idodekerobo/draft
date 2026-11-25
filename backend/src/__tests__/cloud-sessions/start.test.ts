import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { SandboxProvider, SandboxRef, SandboxSpec } from "../../metaharness/sandbox/providers";
import type { SandboxDeploymentConfig } from "../../metaharness/sandbox/config";
import { CredentialError } from "../../credentials/crypto";
import { verifyAgentRunToken } from "../../metaharness/runs/run-token";
import { beginCloudSession, startCloudSession, type StartCloudSessionDeps } from "../../cloud-sessions/start";
import type { CloudStartInput } from "../../cloud-sessions/parse-start";
import type { SnapshotStore } from "../../cloud-sessions/snapshot-seed";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "66666666-6666-4666-8666-666666666666";
const VERSION = "44444444-4444-4444-8444-444444444444";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NONCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "cloud-start-test-secret";
const CLAUDE_TOKEN = "sk-ant-oat-claude-login-test";
const NOW = Date.parse("2026-11-18T10:00:00.000Z");

const config: SandboxDeploymentConfig = {
  callbackUrl: "https://api.draft.test/sandbox/callback",
  callbackSecret: SECRET,
  supabaseUrl: "https://project.supabase.co",
  provider: { kind: "fly", apiToken: "fly-token", appName: "draft-sandbox", image: `registry.fly.io/draft-sandbox@sha256:${"a".repeat(64)}`, region: "iad" },
};

const REF: SandboxRef = { provider: "fly", machine: "machine-1", volume: { provider: "fly", id: "vol-1", region: "iad" } };

const input: CloudStartInput = {
  workspaceId: WS,
  ownerUserId: OWNER,
  harness: "claude",
  model: "haiku",
  reasoningEffort: null,
  network: "restricted",
  seed: { kind: "repo", gitRemote: "https://github.com/acme/app.git", repo: "acme/app", branch: "main" },
};

let db: FakeDb;

beforeEach(() => {
  db = fakeDb(
    {
      workspaces: [{ id: WS, timezone: "UTC", current_context_version_id: VERSION }],
      sessions: [],
      agent_runs: [],
      errors: [],
    },
    {
      unique: { sessions: [["id"]], agent_runs: [["workspace_id", "idempotency_key"]] },
    },
  );
});

/** A provider that records its calls. Each failure is an error the matching step throws. */
function fakeProvider(failures: { create?: Error; start?: Error; destroy?: Error } = {}) {
  const calls: string[] = [];
  const created: SandboxSpec[] = [];
  const destroyed: SandboxRef[] = [];
  const provider: SandboxProvider = {
    async create(spec) {
      calls.push("create");
      if (failures.create) throw failures.create;
      created.push(spec);
      return REF;
    },
    async start() {
      calls.push("start");
      if (failures.start) throw failures.start;
    },
    async stop() {},
    async destroy(ref) {
      calls.push("destroy");
      destroyed.push(ref);
      if (failures.destroy) throw failures.destroy;
    },
    async destroyMachine() {},
    async status() {
      return "running";
    },
  };
  return { provider, calls, created, destroyed };
}

function deps(overrides: Partial<StartCloudSessionDeps> & { provider: SandboxProvider }): StartCloudSessionDeps {
  const ids = [SESSION, RUN, NONCE];
  return {
    client: fakeClient(db),
    config,
    tokenSecret: SECRET,
    resolveCredential: async () => ({ credentialId: "cred-1", secret: CLAUDE_TOKEN }),
    now: () => NOW,
    newId: () => ids.shift() ?? crypto.randomUUID(),
    ...overrides,
  };
}

const session = () => db.tables.sessions![0]!;
const run = () => db.tables.agent_runs![0]!;
const errorCodes = () => db.tables.errors!.map((row) => (row.detail_json as { code?: string }).code);

describe("startCloudSession", () => {
  let logs: unknown[][];
  let spies: Array<{ mockRestore(): void }>;
  beforeEach(() => {
    logs = [];
    spies = ["log", "error", "warn", "info"].map((level) => spyOn(console, level as "log").mockImplementation((...args: unknown[]) => void logs.push(args)));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it("inserts the session and its run, then creates and starts the sandbox with a 10 GB volume", async () => {
    const fly = fakeProvider();
    const outcome = await startCloudSession(input, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: true, sessionId: SESSION });
    expect(session()).toMatchObject({
      id: SESSION,
      workspace_id: WS,
      owner_user_id: OWNER,
      execution_target: "sandbox",
      adapter_id: "claude-terminal",
      host_id: `cloud:${SESSION}`,
      host_name: null,
      status: "starting",
      harness: "claude",
      model: "haiku",
      git_remote: "https://github.com/acme/app.git",
      folder_name: "app",
      seed: { kind: "repo", branch: "main" },
      sandbox_volume: REF.volume,
    });
    expect(fly.calls).toEqual(["create", "start"]);
    expect(fly.created[0]).toMatchObject({ runId: RUN, volume: { sizeGb: 10 }, metadata: { session_id: SESSION, run_id: RUN, kind: "cloud_session" } });
    expect(run()).toMatchObject({
      id: RUN,
      kind: "interactive",
      status: "running",
      session_id: SESSION,
      on_behalf_of_user_id: OWNER,
      sandbox_machine_id: "machine-1",
      trigger: { type: "manual", requestedBy: OWNER },
      harness: "claude",
      model: "haiku",
    });
    expect(run().execution).toEqual({ target: { type: "sandbox" }, adapterId: "claude-terminal" });
    expect(run().computer).toEqual({ type: "sandbox", profileId: "default", workingDirectory: "/data/workspace", network: "restricted" });
    expect(run().started_at).toBeString();
  });

  it("persists the selected starting mode before the sandbox launches", async () => {
    const fly = fakeProvider();
    expect(await startCloudSession({ ...input, permissionMode: "plan" }, deps({ provider: fly.provider }))).toEqual({ ok: true, sessionId: SESSION });
    expect(session()).toMatchObject({ permission_mode: "plan" });
    expect(fly.calls).toEqual(["create", "start"]);
  });

  it("gives the run the cloud toolset and the session permissions, with GitHub scoped to the seed repository", async () => {
    await startCloudSession(input, deps({ provider: fakeProvider().provider }));

    const permissions = run().permissions as Array<{ tool: string; limits?: unknown }>;
    const names = permissions.map((p) => p.tool);
    for (const tool of ["context.read", "context.write", "sources.search", "sources.read", "skills.list", "skills.add", "routines.runs"]) {
      expect(names).toContain(tool);
    }
    expect(names).not.toContain("people.notify");
    expect(permissions.find((p) => p.tool === "github.credential")).toEqual({ tool: "github.credential", limits: { repos: ["acme/app"], access: "write" } });

    const toolset = run().toolset as { nativeTools: Array<{ tool: string }> };
    expect(toolset.nativeTools.map((tool) => tool.tool)).toEqual(expect.arrayContaining(["Read", "Glob"]));
  });

  it("passes the environment the host reads, and a run token that the run's claims verify", async () => {
    const fly = fakeProvider();
    await startCloudSession(input, deps({ provider: fly.provider }));

    const env = fly.created[0]!.env;
    expect(Object.keys(env).sort()).toEqual(
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "DRAFT_API_BASE_URL",
        "DRAFT_EGRESS_HOSTS",
        "DRAFT_MCP_TOKEN",
        "DRAFT_MCP_URL",
        "DRAFT_MODE",
        "DRAFT_NETWORK",
        "DRAFT_RUN_ID",
        "DRAFT_RUN_TOKEN",
        "DRAFT_SEED",
        "DRAFT_SESSION_ID",
        "DRAFT_WORKSPACE_ID",
      ].sort(),
    );
    expect(env).toMatchObject({
      DRAFT_MODE: "host",
      DRAFT_SESSION_ID: SESSION,
      DRAFT_WORKSPACE_ID: WS,
      DRAFT_RUN_ID: RUN,
      DRAFT_API_BASE_URL: "https://api.draft.test",
      DRAFT_MCP_URL: `https://api.draft.test/runs/${RUN}/mcp`,
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      DRAFT_SEED: JSON.stringify({ kind: "repo", gitRemote: "https://github.com/acme/app.git", branch: "main" }),
      DRAFT_NETWORK: "restricted",
    });
    const hosts = env.DRAFT_EGRESS_HOSTS!.split(",");
    for (const host of ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "api.anthropic.com", "api.draft.test", "project.supabase.co"]) {
      expect(hosts).toContain(host);
    }

    const claims = verifyAgentRunToken(env.DRAFT_RUN_TOKEN!, SECRET, { now: NOW });
    expect(claims).toMatchObject({ runId: RUN, workspaceId: WS, scope: "host", expiresAt: NOW + 24 * 60 * 60 * 1_000 });
  });

  it("gives the agent its own mcp-scoped token, which is not the host's", async () => {
    const fly = fakeProvider();
    await startCloudSession(input, deps({ provider: fly.provider }));

    const env = fly.created[0]!.env;
    expect(env.DRAFT_MCP_TOKEN).toBeTruthy();
    expect(env.DRAFT_MCP_TOKEN).not.toBe(env.DRAFT_RUN_TOKEN);
    const claims = verifyAgentRunToken(env.DRAFT_MCP_TOKEN!, SECRET, { now: NOW });
    expect(claims).toMatchObject({ runId: RUN, workspaceId: WS, scope: "mcp", expiresAt: NOW + 24 * 60 * 60 * 1_000 });
  });

  it("passes an open network to the run and the sandbox", async () => {
    const fly = fakeProvider();
    await startCloudSession({ ...input, network: "open" }, deps({ provider: fly.provider }));
    expect(fly.created[0]!.env.DRAFT_NETWORK).toBe("open");
    expect((run().computer as { network: string }).network).toBe("open");
  });

  it("never logs the Claude login or the run token", async () => {
    const fly = fakeProvider();
    await startCloudSession(input, deps({ provider: fly.provider }));

    const runToken = fly.created[0]!.env.DRAFT_RUN_TOKEN!;
    const mcpToken = fly.created[0]!.env.DRAFT_MCP_TOKEN!;
    const printed = JSON.stringify(logs);
    expect(printed).not.toContain(CLAUDE_TOKEN);
    expect(printed).not.toContain(runToken);
    expect(printed).not.toContain(mcpToken);
    expect(JSON.stringify(db.tables.errors)).not.toContain(CLAUDE_TOKEN);
  });

  it("starts an empty project in an empty folder, with no repository and no GitHub access", async () => {
    const fly = fakeProvider();
    const outcome = await startCloudSession({ ...input, seed: { kind: "empty" } }, deps({ provider: fly.provider }));
    expect(outcome.ok).toBe(true);
    expect(fly.created[0]!.env.DRAFT_SEED).toBe(JSON.stringify({ kind: "routine_run" }));
    expect(session()).toMatchObject({ git_remote: null, folder_name: null, seed: { kind: "empty" } });
    expect(JSON.stringify(run()?.permissions ?? [])).not.toContain("github.credential");
  });

  it("answers with the session before the sandbox has booted, and finishes the launch behind it", async () => {
    const fly = fakeProvider();
    let release!: () => void;
    const booted = new Promise<void>((resolve) => (release = resolve));
    const slow = { ...fly.provider, start: async () => { fly.calls.push("start"); await booted; } };
    const begun = await beginCloudSession(input, deps({ provider: slow }));

    expect(begun.ok).toBe(true);
    expect(session()).toMatchObject({ status: "starting" });
    release();
    expect(await (begun as Extract<typeof begun, { ok: true }>).launch).toEqual({ ok: true, sessionId: SESSION });
    expect(run()).toMatchObject({ status: "running" });
  });

  it("refuses with 409 when the workspace has no Claude login, and creates no session or run", async () => {
    const fly = fakeProvider();
    const outcome = await startCloudSession(
      input,
      deps({ provider: fly.provider, resolveCredential: async () => { throw new CredentialError("Workspace has no Claude Code login", "missing"); } }),
    );

    expect(outcome).toEqual({ ok: false, status: 409, error: "claude_not_connected" });
    expect(fly.calls).toEqual([]);
    expect(db.tables.sessions ?? []).toEqual([]);
    expect(db.tables.agent_runs ?? []).toEqual([]);
    expect(db.tables.errors).toEqual([]);
  });

  it("records an unexpected credential failure and returns 502", async () => {
    const outcome = await startCloudSession(input, deps({ provider: fakeProvider().provider, resolveCredential: async () => { throw new Error("connection reset"); } }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(errorCodes()).toEqual(["claude_credential_failed"]);
    expect(db.tables.sessions ?? []).toEqual([]);
  });

  it("does not destroy anything when the sandbox cannot be created, but records it and ends the session", async () => {
    const fly = fakeProvider({ create: new Error("fly 500") });
    const outcome = await startCloudSession(input, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(fly.calls).toEqual(["create"]);
    expect(errorCodes()).toEqual(["sandbox_create_failed"]);
    expect(db.tables.errors![0]).toMatchObject({ workspace_id: WS, session_id: SESSION, agent_run_id: RUN });
    expect(session()).toMatchObject({ status: "ended", end_reason: "start_failed" });
    expect(run()).toMatchObject({ status: "failed", failure_code: "sandbox_create_failed" });
  });

  it("destroys the sandbox when it does not start, and keeps the machine id it saved", async () => {
    const fly = fakeProvider({ start: new Error("machine did not boot") });
    const outcome = await startCloudSession(input, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(fly.calls).toEqual(["create", "start", "destroy"]);
    expect(fly.destroyed).toEqual([REF]);
    expect(errorCodes()).toEqual(["sandbox_start_failed"]);
    expect(run()).toMatchObject({ status: "failed", failure_code: "sandbox_start_failed", sandbox_machine_id: "machine-1" });
    expect(JSON.stringify(db.tables.errors)).not.toContain(CLAUDE_TOKEN);
    expect(JSON.stringify(db.tables.errors)).not.toContain(fly.created[0]!.env.DRAFT_RUN_TOKEN!);
    expect(session()).toMatchObject({ status: "ended", end_reason: "start_failed", sandbox_volume: REF.volume });
  });

  it("records a failed destroy as its own error, next to the start failure", async () => {
    const fly = fakeProvider({ start: new Error("machine did not boot"), destroy: new Error("fly 503") });
    await startCloudSession(input, deps({ provider: fly.provider }));

    expect(errorCodes().sort()).toEqual(["sandbox_destroy_failed", "sandbox_start_failed"]);
    expect(session()).toMatchObject({ status: "ended", end_reason: "start_failed" });
    expect(run()).toMatchObject({ status: "failed" });
  });

  it("writes no run and starts no sandbox when the session row cannot be created", async () => {
    db.tables.sessions = [{ id: SESSION, workspace_id: WS, status: "live" }];
    const fly = fakeProvider();
    const outcome = await startCloudSession(input, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: false, status: 500, error: "session_create_failed" });
    expect(fly.calls).toEqual([]);
    expect(db.tables.agent_runs).toEqual([]);
    expect(db.tables.errors![0]).toMatchObject({ workspace_id: WS, session_id: null });
    expect(errorCodes()).toEqual(["session_create_failed"]);
  });

  it("ends the session as start_failed when its run cannot be created", async () => {
    db.tables.agent_runs = [{ id: "other-run", workspace_id: WS, idempotency_key: `cloud-session:${SESSION}`, status: "queued" }];
    const fly = fakeProvider();
    const outcome = await startCloudSession(input, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(fly.calls).toEqual([]);
    expect(errorCodes()).toEqual(["run_create_failed"]);
    expect(session()).toMatchObject({ status: "ended", end_reason: "start_failed" });
    expect(db.tables.errors![0]).toMatchObject({ agent_run_id: null });
  });
});

const SNAPSHOT_KEY = `${WS}/${SESSION}/seed.tar.gz`;
const snapshotInput: CloudStartInput = { ...input, seed: { kind: "snapshot", sessionId: SESSION, storageKey: SNAPSHOT_KEY, folderName: "marigold" } };

/** Returns the ids in order. A snapshot start takes its session id from the key, so only the run id and the token nonce come from here. */
function sequence(...values: string[]): () => string {
  const queue = [...values];
  return () => queue.shift() ?? crypto.randomUUID();
}

/** A snapshot store holding the objects a test names. Every link it signs is new, so a test can tell launches apart. */
function fakeSnapshots(objects: string[] = [SNAPSHOT_KEY]) {
  const signed: Array<{ key: string; ttl: number; url: string }> = [];
  const removed: string[] = [];
  const store: SnapshotStore = {
    async exists(key) {
      return objects.includes(key);
    },
    async downloadUrl(key, ttl) {
      const url = `https://project.supabase.co/storage/v1/object/sign/session-seeds/${key}?token=${signed.length + 1}`;
      signed.push({ key, ttl, url });
      return url;
    },
    async remove(keys) {
      removed.push(...keys);
    },
  };
  return { store, signed, removed };
}

describe("startCloudSession from a folder snapshot", () => {
  let logs: unknown[][];
  let spies: Array<{ mockRestore(): void }>;
  beforeEach(() => {
    logs = [];
    spies = ["log", "error", "warn", "info"].map((level) => spyOn(console, level as "log").mockImplementation((...args: unknown[]) => void logs.push(args)));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it("starts under the key's session, stores the key, and gives the host a fresh one-hour download link", async () => {
    const fly = fakeProvider();
    const snapshots = fakeSnapshots();
    const outcome = await startCloudSession(snapshotInput, deps({ provider: fly.provider, snapshots: snapshots.store, newId: sequence(RUN, NONCE) }));

    expect(outcome).toEqual({ ok: true, sessionId: SESSION });
    expect(session()).toMatchObject({
      id: SESSION,
      workspace_id: WS,
      git_remote: null,
      folder_name: "marigold",
      seed: { kind: "snapshot", storageKey: SNAPSHOT_KEY },
      execution_target: "sandbox",
      status: "starting",
      host_id: `cloud:${SESSION}`,
    });
    expect(snapshots.signed).toEqual([{ key: SNAPSHOT_KEY, ttl: 3600, url: expect.stringContaining(SNAPSHOT_KEY) }]);
    expect(fly.created[0]!.env.DRAFT_SEED).toBe(JSON.stringify({ kind: "snapshot", url: snapshots.signed[0]!.url }));
    expect(run()).toMatchObject({ id: RUN, status: "running", sandbox_machine_id: "machine-1" });
  });

  it("gives the run no GitHub credential, since a snapshot has no repository", async () => {
    await startCloudSession(snapshotInput, deps({ provider: fakeProvider().provider, snapshots: fakeSnapshots().store, newId: sequence(RUN, NONCE) }));

    const names = (run().permissions as Array<{ tool: string }>).map((p) => p.tool);
    expect(names).toContain("context.read");
    expect(names).not.toContain("github.credential");
  });

  it("refuses a snapshot that is not uploaded, before any row, run or sandbox exists", async () => {
    const fly = fakeProvider();
    const outcome = await startCloudSession(snapshotInput, deps({ provider: fly.provider, snapshots: fakeSnapshots([]).store, newId: sequence(RUN, NONCE) }));

    expect(outcome).toEqual({ ok: false, status: 409, error: "seed_not_uploaded" });
    expect(db.tables.sessions).toEqual([]);
    expect(db.tables.agent_runs).toEqual([]);
    expect(fly.calls).toEqual([]);
    expect(db.tables.errors).toEqual([]);
  });

  it("records a failed object check and returns 502 before any row exists", async () => {
    const fly = fakeProvider();
    const failing: SnapshotStore = {
      exists: async () => { throw new Error("storage 503"); },
      downloadUrl: async () => "unused",
      remove: async () => undefined,
    };
    const outcome = await startCloudSession(snapshotInput, deps({ provider: fly.provider, snapshots: failing, newId: sequence(RUN, NONCE) }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(db.tables.sessions).toEqual([]);
    expect(errorCodes()).toEqual(["snapshot_check_failed"]);
    expect(fly.calls).toEqual([]);
  });

  it("ends the session as start_failed, fails its run, and creates no sandbox when the download link cannot be made", async () => {
    const fly = fakeProvider();
    const failing: SnapshotStore = {
      exists: async () => true,
      downloadUrl: async () => { throw new Error("sign failed"); },
      remove: async () => undefined,
    };
    const outcome = await startCloudSession(snapshotInput, deps({ provider: fly.provider, snapshots: failing, newId: sequence(RUN, NONCE) }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(fly.calls).toEqual([]);
    expect(errorCodes()).toEqual(["snapshot_link_failed"]);
    expect(session()).toMatchObject({ status: "ended", end_reason: "start_failed" });
    expect(run()).toMatchObject({ status: "failed", failure_code: "snapshot_link_failed" });
  });

  it("never logs the download link", async () => {
    const fly = fakeProvider();
    const snapshots = fakeSnapshots();
    await startCloudSession(snapshotInput, deps({ provider: fly.provider, snapshots: snapshots.store, newId: sequence(RUN, NONCE) }));

    expect(JSON.stringify(logs)).not.toContain(snapshots.signed[0]!.url);
    expect(JSON.stringify(db.tables)).not.toContain(snapshots.signed[0]!.url);
  });
});

const ROUTINE_RUN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const routineInput: CloudStartInput = { ...input, seed: { kind: "routine_run", routineSessionId: ROUTINE_RUN } };
// The routine run is the first row of its table, so the new chat is found by its id.
const newSession = () => db.tables.sessions!.find((row) => row.id === SESSION)!;
const newRun = () => db.tables.agent_runs!.find((row) => row.id === RUN)!;

describe("startCloudSession from a finished routine run", () => {
  let logs: unknown[][];
  let spies: Array<{ mockRestore(): void }>;
  beforeEach(() => {
    logs = [];
    spies = ["log", "error", "warn", "info"].map((level) => spyOn(console, level as "log").mockImplementation((...args: unknown[]) => void logs.push(args)));
    db = fakeDb(
      {
        workspaces: [{ id: WS, timezone: "UTC", current_context_version_id: VERSION }],
        sessions: [
          { id: ROUTINE_RUN, workspace_id: WS, session_type: "routine", status: "ended", end_reason: "completed", scheduled_task_id: "task-1", idempotency_key: "task-1:manual:r1", started_at: "2026-11-17T09:00:00.000Z", ended_at: "2026-11-17T09:03:00.000Z", deleted_at: null },
        ],
        scheduled_tasks: [{ id: "task-1", workspace_id: WS, task_type: "agent_routine", visibility: "shared", created_by_user_id: OWNER, deleted_at: null, config_json: { title: "Digest", prompt: "p", harness: "claude", model: null } }],
        agent_runs: [{ id: "r-row", workspace_id: WS, session_id: ROUTINE_RUN, trigger: { type: "manual", requestedBy: OWNER } }],
        users: [{ id: OWNER, display_name: "Ido", email: "ido@example.test" }],
        errors: [],
      },
      { unique: { sessions: [["id"]], agent_runs: [["workspace_id", "idempotency_key"]] }, rpcs: {} },
    );
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it("starts an empty workspace whose first message is the run's history, authored by the caller", async () => {
    db.rpcs.create_session_input = () => ({ data: { id: "input-1" } });
    const fly = fakeProvider();
    const outcome = await startCloudSession(routineInput, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: true, sessionId: SESSION });
    expect(newSession()).toMatchObject({
      id: SESSION,
      title: "Continued: Digest",
      folder_name: null,
      git_remote: null,
      seed: { kind: "routine_run", routineSessionId: ROUTINE_RUN },
      status: "starting",
    });
    const queued = db.rpcCalls.find((call) => call.name === "create_session_input");
    expect(queued?.args).toMatchObject({ p_session_id: SESSION, p_workspace_id: WS, p_author_user_id: OWNER, p_kind: "message" });
    expect((queued?.args.p_payload as { text: string }).text).toContain("(taskId task-1)");
    expect(fly.calls).toEqual(["create", "start"]);
    expect(fly.created[0]!.env.DRAFT_SEED).toBe(JSON.stringify({ kind: "routine_run" }));
    expect(newRun()).toMatchObject({ status: "running", sandbox_machine_id: "machine-1" });
  });

  it("refuses a run that is still going, before any row, run or sandbox exists", async () => {
    db.tables.sessions![0] = { ...db.tables.sessions![0]!, status: "live", end_reason: null };
    const fly = fakeProvider();
    const outcome = await startCloudSession(routineInput, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: false, status: 409, error: "routine_run_not_finished" });
    expect(db.tables.sessions).toHaveLength(1);
    expect(db.tables.agent_runs).toHaveLength(1);
    expect(fly.calls).toEqual([]);
  });

  it("refuses a run the caller cannot read, as not found", async () => {
    db.tables.scheduled_tasks![0] = { ...db.tables.scheduled_tasks![0]!, visibility: "private", created_by_user_id: "99999999-9999-4999-8999-999999999999" };
    const fly = fakeProvider();
    expect(await startCloudSession(routineInput, deps({ provider: fly.provider }))).toEqual({ ok: false, status: 404, error: "routine_run_not_found" });
    expect(fly.calls).toEqual([]);
  });

  it("ends the new chat as start_failed, and creates no sandbox, when its first message cannot be queued", async () => {
    db.rpcs.create_session_input = () => ({ data: null, error: { message: "queue_full" } });
    const fly = fakeProvider();
    const outcome = await startCloudSession(routineInput, deps({ provider: fly.provider }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(fly.calls).toEqual([]);
    expect(errorCodes()).toEqual(["seed_prompt_failed"]);
    expect(newSession()).toMatchObject({ status: "ended", end_reason: "start_failed" });
  });
});

describe("a snapshot's storage after its start fails", () => {
  let logs: unknown[][];
  let spies: Array<{ mockRestore(): void }>;
  beforeEach(() => {
    logs = [];
    spies = ["log", "error", "warn", "info"].map((level) => spyOn(console, level as "log").mockImplementation((...args: unknown[]) => void logs.push(args)));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it("deletes the snapshot when the sandbox cannot be created", async () => {
    const snapshots = fakeSnapshots();
    const outcome = await startCloudSession(snapshotInput, deps({ provider: fakeProvider({ create: new Error("fly 500") }).provider, snapshots: snapshots.store, newId: sequence(RUN, NONCE) }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(snapshots.removed).toEqual([SNAPSHOT_KEY]);
  });

  it("keeps the snapshot when the start is refused before any row exists, so the upload can be retried", async () => {
    const snapshots = fakeSnapshots([]);
    await startCloudSession(snapshotInput, deps({ provider: fakeProvider().provider, snapshots: snapshots.store, newId: sequence(RUN, NONCE) }));
    expect(snapshots.removed).toEqual([]);
  });

  it("records a failed delete and still reports the start failure", async () => {
    const snapshots = fakeSnapshots();
    snapshots.store.remove = async () => { throw new Error("storage 503"); };
    const outcome = await startCloudSession(snapshotInput, deps({ provider: fakeProvider({ start: new Error("boot") }).provider, snapshots: snapshots.store, newId: sequence(RUN, NONCE) }));

    expect(outcome).toEqual({ ok: false, status: 502, error: "start_failed" });
    expect(errorCodes()).toEqual(expect.arrayContaining(["sandbox_start_failed", "snapshot_remove_failed"]));
  });
});
