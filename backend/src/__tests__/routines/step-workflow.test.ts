import { describe, expect, it, mock } from "bun:test";
import type { RoutineStep } from "draft-core/routine-steps";
import { dispatchAgentRoutine } from "../../routines/dispatch-routine";
import { failStaleRoutineSessions } from "../../routines/fail-stale-routine-sessions";
import { ROUTINE_STALE_AFTER_MS } from "../../routines/config";
import { routineWorkflow } from "../../routines/step-workflow";
import { advanceWorkflow } from "../../routine-steps/advance";
import type { ScheduledTaskRow, AgentRunRow } from "../../types/tables";
import { fakeClient, fakeDb, type FakeDb } from "./fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const TASK = "55555555-5555-4555-8555-555555555555";
const VERSION = "44444444-4444-4444-8444-444444444444";
const OWNER = "66666666-6666-4666-8666-666666666666";
const TEAM = "77777777-7777-4777-8777-777777777777";
const ORG = "88888888-8888-4888-8888-888888888888";

const step = (key: string, overrides: Partial<RoutineStep> = {}): RoutineStep => ({
  key, prompt: `Do ${key}.`, model: null, permissions: [{ tool: "context.read" }], fanOut: { over: "none" }, output: { type: "text" }, ...overrides,
});
const docs = { "company/about.md": { content: "About", sha256: "a".repeat(64) }, "memory/index.md": { content: "M", sha256: "b".repeat(64) }, "product/index.md": { content: "P", sha256: "c".repeat(64) } };

const task = (steps: RoutineStep[]) => ({
  id: TASK, workspace_id: WS, task_type: "agent_routine", created_by_user_id: OWNER, timezone: "UTC", schedule_kind: "cron", schedule_cron: "0 9 * * *",
  config_json: { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: null, steps },
}) as unknown as ScheduledTaskRow;

function newDb(): FakeDb {
  return fakeDb(
    {
      users: [{ id: OWNER, status: "active", primary_team_id: TEAM }],
      sessions: [],
      errors: [],
      agent_runs: [],
      agent_run_source_items: [],
      workspaces: [{ id: WS, team_id: TEAM, organization_id: ORG, timezone: "UTC", current_context_version_id: VERSION }],
      workspace_context_versions: [{ id: VERSION, version_number: 1, documents_json: docs }],
    },
    {
      unique: { sessions: [["workspace_id", "idempotency_key"]], agent_runs: [["workspace_id", "idempotency_key"]] },
      rpcs: { append_session_events: () => ({ data: null }) },
      uuidTables: ["agent_runs"],
    },
  );
}

const launchStep = (db: FakeDb) => mock(async ({ spec }: { spec: { id: string } }) => ({ machineId: `m-${spec.id.slice(0, 4)}`, state: "started", runId: spec.id, bundleHash: "h".repeat(64), callbackExpiresAt: 0 }));

async function start(steps: RoutineStep[], db = newDb(), extra: Record<string, unknown> = {}) {
  const launch = launchStep(db);
  const agentLaunch = mock(async () => {});
  const outcome = await dispatchAgentRoutine({
    task: task(steps), occurrenceAt: "2026-11-26T09:00:00.000Z", config: {} as never, client: fakeClient(db), launch: agentLaunch,
    launchStep: launch as never, kind: "timer", firstEventId: "e1", concurrencyKey: TASK, ...extra,
  });
  return { db, launch, agentLaunch, outcome };
}

const parentOf = (db: FakeDb) => db.tables.agent_runs!.find((row) => row.kind === "routine")!;
const childrenOf = (db: FakeDb) => db.tables.agent_runs!.filter((row) => row.kind === "step");

describe("a routine with steps", () => {
  it("starts no agent for the routine itself: the engine starts the first step run", async () => {
    const { db, launch, agentLaunch, outcome } = await start([step("collect"), step("write")]);
    expect(outcome).toMatchObject({ status: "started" });
    expect(agentLaunch).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(parentOf(db)).toMatchObject({ kind: "routine", status: "running", session_id: outcome.sessionId });
    // Only the first step is planned. The second waits for it.
    expect(childrenOf(db)).toHaveLength(1);
    expect(childrenOf(db)[0]).toMatchObject({ step_key: "collect", status: "running", parent_run_id: parentOf(db).id, instructions: "Do collect." });
    expect(childrenOf(db)[0]!.session_id ?? null).toBeNull();
    expect(db.tables.sessions![0]).toMatchObject({ status: "starting" });
  });

  it("saves its steps, and how it started, on the run so editing the routine cannot change it", async () => {
    const { db } = await start([step("collect")]);
    const saved = parentOf(db).result_json as { steps: RoutineStep[]; routine: { title: string }; startedBy: { type: string } };
    expect(saved.steps.map((entry) => entry.key)).toEqual(["collect"]);
    expect(saved.routine.title).toBe("Weekly digest");
    expect(saved.startedBy).toEqual({ type: "schedule" });
  });

  it("gives each step run the routine's own tools and network, the step's tools only where the routine has them, and no session", async () => {
    const { db } = await start([step("collect", { permissions: [{ tool: "context.read" }, { tool: "context.write" }] })]);
    const child = childrenOf(db)[0]!;
    expect(child.permissions).toEqual([{ tool: "context.read" }, { tool: "context.write" }]);
    expect(child.computer).toMatchObject({ type: "sandbox", network: "open" });
    expect(child.session_id ?? null).toBeNull();
    expect(child.on_behalf_of_user_id).toBe(OWNER);
    // A text step still runs as a structured run, so its answer comes back with its transcript.
    expect(child.output).toMatchObject({ type: "structured" });
  });

  it("carries on through the steps, and ends the session and the run when the last step answers", async () => {
    const { db, launch } = await start([step("collect", { output: { type: "structured", schema: { type: "object" } } }), step("write", { inputsFrom: ["collect"] })]);
    const client = fakeClient(db);
    const deps = { client, config: {} as never, workflow: routineWorkflow, launch: launch as never };
    Object.assign(childrenOf(db)[0]!, { status: "succeeded", result_json: { summary: "Found three facts." } });
    await advanceWorkflow(deps, parentOf(db).id as string);
    const second = childrenOf(db).find((row) => row.step_key === "write")!;
    expect(second.status).toBe("running");
    Object.assign(second, { status: "succeeded", result_json: { text: "Here is the digest." } });
    await advanceWorkflow(deps, parentOf(db).id as string);

    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "completed" });
    expect(parentOf(db).status).toBe("succeeded");
    const events = db.rpcCalls.filter((call) => call.name === "append_session_events").flatMap((call) => call.args.p_events as Array<{ kind: string; payload: { text: string } }>);
    expect(events).toEqual([
      { source_id: "step:collect:summary", kind: "session_note", payload: { text: "Step collect: Found three facts." } },
      { source_id: "step:write:result", kind: "assistant_text", payload: { text: "Here is the digest." } },
    ]);
  });

  it("ends the session as failed, and the run with it, when a step fails for good", async () => {
    const { db, launch } = await start([step("collect")]);
    const deps = { client: fakeClient(db), config: {} as never, workflow: routineWorkflow, launch: launch as never };
    Object.assign(childrenOf(db)[0]!, { status: "failed", attempt: 2, failure_code: "claude_exit", completed_at: new Date().toISOString() });
    expect(await advanceWorkflow(deps, parentOf(db).id as string)).toBe("failed");
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(parentOf(db).status).toBe("failed");
    expect(db.tables.errors!.some((row) => String(row.message).includes("Routine run failed"))).toBe(true);
  });

  it("runs a step once for each stable document when it fans out over documents, and not for memory", async () => {
    const { db, launch } = await start([step("check", { fanOut: { over: "context_documents", filter: "all_stable" } })]);
    expect(childrenOf(db).map((row) => (row.step_item as { key: string }).key).sort()).toEqual(["doc:company/about.md", "doc:product/index.md"]);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("gives a step run its step's prompt, the routine's title and cadence, its document and the earlier answers", async () => {
    const { db } = await start([step("collect", { output: { type: "structured", schema: { type: "object" } } }), step("check", { fanOut: { over: "context_documents", filter: "all_stable" } })]);
    const client = fakeClient(db);
    const parent = parentOf(db) as unknown as Parameters<typeof routineWorkflow.prepareRun>[0]["parent"];
    const first = childrenOf(db)[0]! as unknown as AgentRunRow;
    Object.assign(first, { status: "succeeded", result_json: { summary: "s" } });
    const documentRun = { ...first, id: "99999999-9999-4999-8999-999999999999", step_key: "check", step_item: { key: "doc:company/about.md", type: "document", path: "company/about.md" }, base_context_version_id: VERSION } as AgentRunRow;
    const { bundle, prompt } = await routineWorkflow.prepareRun({ client, parent, step: step("check"), run: documentRun, outputs: { collect: [{ run: first, result: { summary: "s" } }] } });
    expect(prompt).toContain("Do check.");
    expect(prompt).toContain("Routine: Weekly digest");
    expect(prompt).toContain("## This step: check");
    expect(prompt).toContain("Work on this document: input/context/company/about.md");
    expect(prompt).toContain(`input/steps/collect/${first.id}.json`);
    expect(Object.keys(bundle.files)).toEqual(expect.arrayContaining(["input/context/company/about.md", `input/steps/collect/${first.id}.json`]));
    expect(prompt).toContain('"text" field');
  });
});

describe("a routine whose steps are going", () => {
  async function staleSession(db: FakeDb) {
    const old = new Date(Date.now() - ROUTINE_STALE_AFTER_MS - 60_000).toISOString();
    db.tables.sessions![0]!.started_at = old;
    return failStaleRoutineSessions(fakeClient(db), new Date());
  }

  it("is not failed as stale while a step run is queued or going", async () => {
    const { db } = await start([step("collect")]);
    expect(await staleSession(db)).toBe(0);
    expect(db.tables.sessions![0]!.status).toBe("starting");
  });

  it("is failed as stale once no step run is going", async () => {
    const { db } = await start([step("collect")]);
    Object.assign(childrenOf(db)[0]!, { status: "failed", completed_at: new Date().toISOString() });
    expect(await staleSession(db)).toBe(1);
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
  });
});
