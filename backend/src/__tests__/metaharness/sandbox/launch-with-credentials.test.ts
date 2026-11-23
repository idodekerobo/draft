import { launchSummarizationBatch } from "../../../summarization/run-summarization-batch";
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { saveCodexCredential, resolveCodexCredential } from "../../../credentials/codex-credential";
import { completeRunCredentials, launchWithCredentials, RoutineLeaseBusyError } from "../../../metaharness/sandbox/launch-with-credentials";
import * as launcher from "../../../metaharness/sandbox/launch";
import { buildSummarizationRunSpec } from "../../../summarization/run-spec";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const login = (token: string) => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: token } });
const spec = buildSummarizationRunSpec({
  id: RUN, workspaceId: WS, scheduledTaskId: "55555555-5555-4555-8555-555555555555", occurrenceAt: "2026-11-23T03:00:00.000Z",
  contextVersionId: "44444444-4444-4444-8444-444444444444", resultSchema: {},
  settings: { harness: "codex", model: "gpt-6-luna", prompt: "Summarize." },
});

beforeAll(() => { process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= randomBytes(32).toString("base64"); });
let launchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => launchSpy?.mockRestore());

async function setup(acquired = true) {
  const db = fakeDb({ agent_runs: [{ id: RUN, workspace_id: WS, harness: "codex" }] }, {
    rpcs: { acquire_credential_lease: () => ({ data: acquired }), release_credential_lease: () => ({ data: true }) },
  });
  const client = fakeClient(db);
  const credentialId = await saveCodexCredential(client, WS, login("before"), "person");
  return { db, client, credentialId };
}

describe("the credential-aware sandbox launcher", () => {
  it("passes the saved spec and Codex login to the standard launcher under a run lease", async () => {
    const { db, client, credentialId } = await setup();
    launchSpy = spyOn(launcher, "launchSandboxRun").mockResolvedValue({ machineId: "box", runId: RUN, state: "started", bundleHash: "b", callbackExpiresAt: 0 });
    const input = { spec, bundle: {} as never, prompt: { kind: "items" as const, manifestPath: "input/manifest.json" }, config: {} as never };
    await launchWithCredentials(input, client);
    expect(launchSpy).toHaveBeenCalledWith({ ...input, credentials: { codexAuthJson: login("before") } });
    expect(db.rpcCalls[0]).toMatchObject({ name: "acquire_credential_lease", args: { p_run_id: RUN, p_credential_id: credentialId } });
  });

  it("does not launch when the login is busy, and releases the lease when launch fails", async () => {
    const busy = await setup(false);
    launchSpy = spyOn(launcher, "launchSandboxRun").mockRejectedValue(new Error("launch failed"));
    const input = { spec, bundle: {} as never, prompt: { kind: "text" as const, text: "Summarize" }, config: {} as never };
    await expect(launchWithCredentials(input, busy.client)).rejects.toBeInstanceOf(RoutineLeaseBusyError);
    expect(launchSpy).not.toHaveBeenCalled();
    const free = await setup();
    await expect(launchWithCredentials(input, free.client)).rejects.toThrow("launch failed");
    expect(free.db.rpcCalls.at(-1)?.name).toBe("release_credential_lease");
  });

  it("saves a refreshed login before releasing it and ignores callbacks after another run takes the lease", async () => {
    const { db, client } = await setup();
    db.tables.credentials![0]!.lease_run_id = RUN;
    await completeRunCredentials(client, RUN, login("refreshed"));
    expect((await resolveCodexCredential(client, WS)).authJson).toBe(login("refreshed"));
    expect(db.rpcCalls.at(-1)?.name).toBe("release_credential_lease");
    db.tables.credentials![0]!.lease_run_id = "new-run";
    const calls = db.rpcCalls.length;
    await completeRunCredentials(client, RUN, login("stale"));
    expect((await resolveCodexCredential(client, WS)).authJson).toBe(login("refreshed"));
    expect(db.rpcCalls).toHaveLength(calls);
  });
});


describe("summarization's login reservation", () => {
  it("does not claim captured sessions or consume their attempts while the Codex login is busy", async () => {
    const { db, client } = await setup(false);
    db.tables.scheduled_tasks = [{ id: "task", workspace_id: WS, task_type: "summarize_sessions", config_json: { harness: "codex", model: null, prompt: "Summarize." } }];
    const result = await launchSummarizationBatch({ workspaceId: WS, client, config: {} as never, schedule: { scheduledTaskId: "task", occurrenceAt: "2026-11-23T03:00:00.000Z" } });
    expect(result).toBeNull();
    expect(db.rpcCalls.some((call) => call.name === "claim_pending_summary_sessions")).toBe(false);
  });

  it("releases a reserved login when there is nothing to summarize", async () => {
    const { db, client } = await setup();
    db.tables.scheduled_tasks = [{ id: "task", workspace_id: WS, task_type: "summarize_sessions", config_json: { harness: "codex", model: null, prompt: "Summarize." } }];
    db.rpcs.claim_pending_summary_sessions = () => ({ data: [] });
    const result = await launchSummarizationBatch({ workspaceId: WS, client, config: {} as never, schedule: { scheduledTaskId: "task", occurrenceAt: "2026-11-23T03:00:00.000Z" } });
    expect(result).toBeNull();
    expect(db.rpcCalls.at(-1)?.name).toBe("release_credential_lease");
    expect(db.rpcCalls.at(-1)?.args.p_run_id).toBe(db.rpcCalls[0]?.args.p_run_id);
  });
});
