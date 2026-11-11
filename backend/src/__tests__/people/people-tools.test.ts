import { describe, expect, it } from "bun:test";
import { agentActor, parseAgentRunId, parseContextVersionId, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import type { AnyDraftToolPermission, ToolCaller } from "draft-core/tools";
import { SYNTHESIS_PERMISSIONS } from "draft-core/tools";
import { invokeTool } from "../../metaharness/tools/invoke-tool";
import { createPeopleTools } from "../../metaharness/tools/definitions/people";
import { ToolRegistry } from "../../metaharness/tools/tool-registry";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const TEAM = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const SOURCE = "66666666-6666-4666-8666-666666666666";

const newDb = () =>
  fakeDb(
    {
      workspaces: [{ id: WS, team_id: TEAM }],
      users: [
        { id: OWNER, email: "uzo@example.com", display_name: "Uzo", status: "active", primary_team_id: TEAM, organization_role: "member" },
        { id: ADMIN, email: "ada@example.com", display_name: "Ada", status: "active", primary_team_id: TEAM, organization_role: "admin" },
      ],
      people: [],
      person_identities: [],
      source_connections: [],
      agent_run_tool_calls: [],
    },
    { unique: { people: [["workspace_id", "user_id"]], person_identities: [["workspace_id", "provider", "external_id"]] }, uuidTables: ["people"] },
  );

function setup(db = newDb()) {
  const registry = new ToolRegistry(createPeopleTools(fakeClient(db)));
  const audit = async () => {};
  const authorizeUser = async () => null;
  const call = (caller: ToolCaller, tool: string, args: unknown) => invokeTool({ registry, audit, authorizeUser }, caller, tool, args);
  return { db, call };
}

const runSpec = (permissions: ReadonlyArray<AnyDraftToolPermission>, onBehalfOf: string | null = OWNER): AgentRunSpec => ({
  id: parseAgentRunId(RUN),
  kind: "routine",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "system", reason: "manual" },
  actor: agentActor(parseAgentRunId(RUN)),
  onBehalfOf: onBehalfOf ? parseUserId(onBehalfOf) : null,
  runtime: { type: "cloud", environment: { nativeTools: [], mcpServers: [], skills: [], instructions: [] } },
  harness: "claude",
  model: null,
  instructions: "",
  inputs: { contextVersionId: parseContextVersionId("77777777-7777-4777-8777-777777777777") },
  permissions,
  output: { type: "text" },
});
const asRun = (permissions: ReadonlyArray<AnyDraftToolPermission> = SYNTHESIS_PERMISSIONS, onBehalfOf: string | null = OWNER): ToolCaller => ({ type: "run", run: runSpec(permissions, onBehalfOf) });
const asUser = (userId = OWNER): ToolCaller => ({ type: "user", userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "cli" });

const evidence = { quote: "Cory joined the standup as our new intern.", sourceItemId: SOURCE };

describe("people.find", () => {
  it("seeds members first, then finds by name, email and provider id, with no contact data in the answer", async () => {
    const { call, db } = setup();
    const byName = await call(asUser(), "people.find", { name: "uzo" });
    expect(byName).toMatchObject({ status: "ok", output: { people: [{ displayName: "Uzo", status: "active", isUser: true, reachable: { slack: false } }] } });
    expect(JSON.stringify(byName)).not.toContain("example.com");

    const byEmail = await call(asUser(), "people.find", { email: "ADA@example.com" });
    expect((byEmail as { output: { people: unknown[] } }).output.people).toHaveLength(1);

    const uzoId = db.tables.people!.find((p) => p.user_id === OWNER)!.id;
    db.tables.person_identities!.push({ id: "s1", workspace_id: WS, person_id: uzoId, provider: "slack", external_id: "U1", status: "from_connection" });
    const byProvider = await call(asUser(), "people.find", { provider: "slack", externalId: "U1" });
    expect((byProvider as { output: { people: Array<{ displayName: string }> } }).output.people.map((p) => p.displayName)).toEqual(["Uzo"]);
  });

  it("marks Slack reachable only for a trusted identity on a connected workspace", async () => {
    const { call, db } = setup();
    await call(asUser(), "people.find", {});
    const uzoId = db.tables.people!.find((p) => p.user_id === OWNER)!.id;
    db.tables.person_identities!.push({ id: "s1", workspace_id: WS, person_id: uzoId, provider: "slack", external_id: "U1", status: "inferred" });
    db.tables.source_connections!.push({ id: "c1", workspace_id: WS, provider: "slack", status: "active" });
    const guess = await call(asUser(), "people.find", { name: "uzo" });
    expect((guess as { output: { people: Array<{ reachable: { slack: boolean } }> } }).output.people[0]!.reachable.slack).toBe(false);
    db.tables.person_identities!.find((i) => i.provider === "slack")!.status = "from_connection";
    const proven = await call(asUser(), "people.find", { name: "uzo" });
    expect((proven as { output: { people: Array<{ reachable: { slack: boolean } }> } }).output.people[0]!.reachable.slack).toBe(true);
  });

  it("resolves me to the caller's own person: the user for a person, onBehalfOf for a run", async () => {
    const { call } = setup();
    expect(await call(asUser(ADMIN), "people.find", { me: true })).toMatchObject({ output: { people: [{ displayName: "Ada" }] } });
    expect(await call(asRun(), "people.find", { me: true })).toMatchObject({ output: { people: [{ displayName: "Uzo" }] } });
  });

  it("refuses me for a run that acts for no one", async () => {
    const { call } = setup();
    expect(await call(asRun(SYNTHESIS_PERMISSIONS, null), "people.find", { me: true })).toMatchObject({ status: "refused", code: "not_allowed" });
  });
});

describe("people.create", () => {
  it("creates a pending person for a run, recording the run and who it acted for, never a human actor", async () => {
    const { call, db } = setup();
    const result = await call(asRun(), "people.create", { displayName: "Cory Banks", evidence, identities: [{ provider: "email", externalId: "Cory@Acme.com" }] });
    expect(result).toMatchObject({ status: "ok", output: { created: true, person: { displayName: "Cory Banks", status: "pending", isUser: false } } });

    const row = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    expect(row).toMatchObject({ created_by: "agent", created_by_run_id: RUN, on_behalf_of_user_id: OWNER, status: "pending", evidence });
    expect(row.created_by_user_id ?? null).toBeNull();
    expect(db.tables.person_identities).toContainEqual(expect.objectContaining({ person_id: row.id, provider: "email", external_id: "cory@acme.com", status: "inferred" }));
  });

  it("records a run that acts for no one with no delegator", async () => {
    const { call, db } = setup();
    await call(asRun(SYNTHESIS_PERMISSIONS, null), "people.create", { displayName: "Dana Lee", evidence });
    const row = db.tables.people!.find((p) => p.display_name === "Dana Lee")!;
    expect(row).toMatchObject({ created_by: "agent", created_by_run_id: RUN });
    expect(row.on_behalf_of_user_id ?? null).toBeNull();
  });

  it("makes a member's addition pending and an admin's addition active, recording the person who did it", async () => {
    const { call, db } = setup();
    await call(asUser(OWNER), "people.create", { displayName: "Pat One", evidence });
    await call(asUser(ADMIN), "people.create", { displayName: "Sam Two", evidence });
    expect(db.tables.people!.find((p) => p.display_name === "Pat One")).toMatchObject({ status: "pending", created_by: "user", created_by_user_id: OWNER });
    expect(db.tables.people!.find((p) => p.display_name === "Sam Two")).toMatchObject({ status: "active", created_by: "user", created_by_user_id: ADMIN });
    expect(db.tables.people!.find((p) => p.display_name === "Pat One")!.created_by_run_id ?? null).toBeNull();
  });

  it("returns the existing person on an exact identity match, and creates nothing", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence, identities: [{ provider: "slack", externalId: "U77" }] });
    const again = await call(asRun(), "people.create", { displayName: "Someone Else", evidence, identities: [{ provider: "slack", externalId: "U77" }] });
    expect(again).toMatchObject({ output: { created: false, person: { displayName: "Cory Banks" } } });
    expect(db.tables.people!.filter((p) => p.created_by === "agent")).toHaveLength(1);
  });

  it("returns candidates for a close name, and creates the person only with force", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Sam Rivera", evidence });
    const close = await call(asRun(), "people.create", { displayName: "sam", evidence });
    expect(close).toMatchObject({ output: { created: false, candidates: [{ displayName: "Sam Rivera" }] } });
    expect(db.tables.people!.filter((p) => p.created_by === "agent")).toHaveLength(1);

    const forced = await call(asRun(), "people.create", { displayName: "Sam Okafor", evidence, force: true });
    expect(forced).toMatchObject({ output: { created: true } });
    expect(db.tables.people!.filter((p) => p.created_by === "agent")).toHaveLength(2);
  });

  it("remembers a rejected name, and force does not override it", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    await call(asUser(ADMIN), "people.reject", { personId: cory.id });

    expect(await call(asRun(), "people.create", { displayName: "Cory Banks", evidence })).toMatchObject({ output: { created: false, rejected: true } });
    expect(await call(asRun(), "people.create", { displayName: "Cory B", evidence, force: true })).toMatchObject({ output: { created: false, rejected: true } });
    expect(db.tables.people!.filter((p) => p.created_by === "agent")).toHaveLength(1);
  });

  it("stops a run at maxPerRun, counting only calls that worked", async () => {
    const { call, db } = setup();
    const permissions: AnyDraftToolPermission[] = [{ tool: "people.find" }, { tool: "people.create", limits: { maxPerRun: 2 } }];
    for (const status of ["ok", "refused", "ok"]) db.tables.agent_run_tool_calls!.push({ agent_run_id: RUN, tool_name: "people.create", status });
    expect(await call(asRun(permissions), "people.create", { displayName: "Eve Third", evidence })).toMatchObject({ status: "refused", code: "limit_reached" });
    db.tables.agent_run_tool_calls!.pop();
    expect(await call(asRun(permissions), "people.create", { displayName: "Eve Third", evidence })).toMatchObject({ status: "ok" });
  });

  it("does not let a run without the permission call it", async () => {
    const { call } = setup();
    expect(await call(asRun([{ tool: "people.find" }]), "people.create", { displayName: "Eve Third", evidence })).toMatchObject({ status: "denied", code: "not_permitted" });
  });
});

describe("people.add_identity", () => {
  it("adds an inferred identity, never lowers a trusted one, and refuses an identity that belongs to someone else", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    await call(asRun(), "people.create", { displayName: "Dana Lee", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    const dana = db.tables.people!.find((p) => p.display_name === "Dana Lee")!;

    expect(await call(asRun(), "people.add_identity", { personId: cory.id, provider: "slack", externalId: "U9", evidence: {} })).toMatchObject({ output: { outcome: "created" } });
    expect(db.tables.person_identities).toContainEqual(expect.objectContaining({ person_id: cory.id, external_id: "U9", status: "inferred" }));

    db.tables.person_identities!.push({ id: "t1", workspace_id: WS, person_id: dana.id, provider: "email", external_id: "dana@x.com", status: "confirmed", handle: null });
    expect(await call(asRun(), "people.add_identity", { personId: dana.id, provider: "email", externalId: "DANA@x.com", evidence: {} })).toMatchObject({ output: { outcome: "unchanged" } });
    expect(db.tables.person_identities!.find((i) => i.id === "t1")!.status).toBe("confirmed");

    expect(await call(asRun(), "people.add_identity", { personId: cory.id, provider: "email", externalId: "dana@x.com", evidence: {} })).toMatchObject({ status: "refused", code: "identity_taken" });
  });

  it("refuses a person from another workspace", async () => {
    const { call, db } = setup();
    db.tables.people!.push({ id: "88888888-8888-4888-8888-888888888888", workspace_id: OTHER_WS, display_name: "Elsewhere" });
    expect(await call(asRun(), "people.add_identity", { personId: "88888888-8888-4888-8888-888888888888", provider: "slack", externalId: "U1", evidence: {} })).toMatchObject({ status: "refused", code: "person_not_found" });
  });
});

describe("people.approve and people.reject", () => {
  it("lets an admin approve a pending person, recording who decided and when", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    expect(await call(asUser(ADMIN), "people.approve", { personId: cory.id })).toMatchObject({ output: { person: { status: "active" } } });
    expect(cory).toMatchObject({ status: "active", decided_by_user_id: ADMIN });
    expect(cory.decided_at).toBeTruthy();
    expect(await call(asUser(ADMIN), "people.approve", { personId: cory.id })).toMatchObject({ status: "refused", code: "already_decided" });
  });

  it("keeps a rejection reason in the evidence", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    await call(asUser(ADMIN), "people.reject", { personId: cory.id, reason: "a client" });
    expect(cory).toMatchObject({ status: "rejected", evidence: { quote: evidence.quote, rejectionReason: "a client" } });
  });

  it("never lets a run approve or reject, even one that holds the permission", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    const permissions: AnyDraftToolPermission[] = [...SYNTHESIS_PERMISSIONS, { tool: "people.approve" }, { tool: "people.reject" }];
    expect(await call(asRun(permissions), "people.approve", { personId: cory.id })).toMatchObject({ status: "denied", code: "caller_not_authorized" });
    expect(await call(asRun(permissions), "people.reject", { personId: cory.id })).toMatchObject({ status: "denied", code: "caller_not_authorized" });
    expect(cory.status).toBe("pending");
  });

  it("refuses a member who is not an admin", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    expect(await call(asUser(OWNER), "people.approve", { personId: cory.id })).toMatchObject({ status: "refused", code: "not_admin" });
    expect(cory.status).toBe("pending");
  });

  it("refuses a person from another workspace", async () => {
    const { call, db } = setup();
    db.tables.people!.push({ id: "88888888-8888-4888-8888-888888888888", workspace_id: OTHER_WS, display_name: "Elsewhere", status: "pending" });
    expect(await call(asUser(ADMIN), "people.approve", { personId: "88888888-8888-4888-8888-888888888888" })).toMatchObject({ status: "refused", code: "person_not_found" });
  });
});

describe("synthesis permissions", () => {
  it("can find, create and add identities, and cannot notify, approve or reject", () => {
    const tools = SYNTHESIS_PERMISSIONS.map((permission) => permission.tool);
    expect(tools).toEqual(expect.arrayContaining(["context.read", "context.write", "people.find", "people.create", "people.add_identity"]));
    expect(tools).not.toContain("people.notify");
    expect(tools).not.toContain("people.approve");
    expect(tools).not.toContain("people.reject");
  });
});
