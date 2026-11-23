import { describe, expect, it } from "bun:test";
import { parseAgentRunId, parseContextVersionId, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller, SYNTHESIS_PERMISSIONS, DRAFT_TOOLS, type AnyDraftToolPermission, type ToolCaller } from "draft-core/tools";
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
      connections: [],
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
    network: "restricted",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "system", reason: "manual" },
  onBehalfOf: onBehalfOf ? parseUserId(onBehalfOf) : null,
  runtime: { type: "cloud", toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] } },
  harness: "claude",
  model: null,
  instructions: "",
  inputs: { contextVersionId: parseContextVersionId("77777777-7777-4777-8777-777777777777") },
  permissions,
  output: { type: "text" },
});
const asRun = (permissions: ReadonlyArray<AnyDraftToolPermission> = SYNTHESIS_PERMISSIONS, onBehalfOf: string | null = OWNER): ToolCaller => runCaller(runSpec(permissions, onBehalfOf));
const asUser = (userId = OWNER): ToolCaller => personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "cli" });

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
    db.tables.connections!.push({ id: "c1", workspace_id: WS, provider: "slack", status: "active" });
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

describe("people.update", () => {
  it("adds an inferred identity, never lowers a trusted one, and refuses an identity that belongs to someone else", async () => {
    const { call, db } = setup();
    await call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    await call(asRun(), "people.create", { displayName: "Dana Lee", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    const dana = db.tables.people!.find((p) => p.display_name === "Dana Lee")!;

    expect(await call(asRun(), "people.update", { personId: cory.id, provider: "slack", externalId: "U9", evidence: {} })).toMatchObject({ output: { outcome: "created" } });
    expect(db.tables.person_identities).toContainEqual(expect.objectContaining({ person_id: cory.id, external_id: "U9", status: "inferred" }));

    db.tables.person_identities!.push({ id: "t1", workspace_id: WS, person_id: dana.id, provider: "email", external_id: "dana@x.com", status: "confirmed", handle: null });
    expect(await call(asRun(), "people.update", { personId: dana.id, provider: "email", externalId: "DANA@x.com", evidence: {} })).toMatchObject({ output: { outcome: "unchanged" } });
    expect(db.tables.person_identities!.find((i) => i.id === "t1")!.status).toBe("confirmed");

    expect(await call(asRun(), "people.update", { personId: cory.id, provider: "email", externalId: "dana@x.com", evidence: {} })).toMatchObject({ status: "refused", code: "identity_taken" });
  });

  it("refuses a person from another workspace", async () => {
    const { call, db } = setup();
    db.tables.people!.push({ id: "88888888-8888-4888-8888-888888888888", workspace_id: OTHER_WS, display_name: "Elsewhere" });
    expect(await call(asRun(), "people.update", { personId: "88888888-8888-4888-8888-888888888888", provider: "slack", externalId: "U1", evidence: {} })).toMatchObject({ status: "refused", code: "person_not_found" });
  });
});

describe("people.update: remove and replace", () => {
  async function withCory() {
    const harness = setup();
    await harness.call(asRun(), "people.create", { displayName: "Cory Banks", evidence });
    const cory = harness.db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    return { ...harness, cory };
  }

  it("removes an id that was added as a guess", async () => {
    const { call, db, cory } = await withCory();
    await call(asRun(), "people.update", { personId: cory.id, provider: "slack", externalId: "U9" });
    expect(await call(asRun(), "people.update", { personId: cory.id, provider: "slack", remove: "U9" })).toMatchObject({ status: "ok", output: { outcome: "removed" } });
    expect(db.tables.person_identities).not.toContainEqual(expect.objectContaining({ external_id: "U9" }));
  });

  it("corrects a wrong email in one step, and the correction is a guess too", async () => {
    const { call, db, cory } = await withCory();
    await call(asRun(), "people.update", { personId: cory.id, provider: "email", externalId: "cory@typo.com" });
    const result = await call(asRun(), "people.update", { personId: cory.id, provider: "email", replaces: "cory@typo.com", externalId: "Cory@Right.com" });
    expect(result).toMatchObject({ status: "ok", output: { outcome: "replaced" } });
    const emails = db.tables.person_identities!.filter((i) => i.person_id === cory.id && i.provider === "email");
    expect(emails.map((i) => [i.external_id, i.status])).toEqual([["cory@right.com", "inferred"]]);
  });

  it("will not remove or replace an id a connection or a workspace member vouches for, and says why", async () => {
    const { call, db, cory } = await withCory();
    db.tables.person_identities!.push({ id: "t1", workspace_id: WS, person_id: cory.id, provider: "slack", external_id: "U1", status: "from_connection", handle: null });
    const removed = await call(asRun(), "people.update", { personId: cory.id, provider: "slack", remove: "U1" });
    expect(removed).toMatchObject({ status: "refused", code: "identity_trusted" });
    expect((removed as { message: string }).message).toContain("keeps it in step with that source");
    expect(await call(asRun(), "people.update", { personId: cory.id, provider: "slack", replaces: "U1", externalId: "U2" })).toMatchObject({ status: "refused", code: "identity_trusted" });
    expect(db.tables.person_identities!.filter((i) => i.person_id === cory.id).map((i) => i.external_id)).toEqual(["U1"]);
  });

  it("says when the person has no such id, without saying who owns it", async () => {
    const { call, db, cory } = await withCory();
    await call(asRun(), "people.create", { displayName: "Dana Lee", evidence });
    const dana = db.tables.people!.find((p) => p.display_name === "Dana Lee")!;
    await call(asRun(), "people.update", { personId: dana.id, provider: "slack", externalId: "U5" });
    const result = await call(asRun(), "people.update", { personId: cory.id, provider: "slack", remove: "U5" });
    expect(result).toMatchObject({ status: "refused", code: "identity_not_found" });
    expect(JSON.stringify(result)).not.toContain("Dana");
    expect(db.tables.person_identities).toContainEqual(expect.objectContaining({ person_id: dana.id, external_id: "U5" }));
  });

  it("keeps the old id when the corrected one belongs to someone else", async () => {
    const { call, db, cory } = await withCory();
    await call(asRun(), "people.create", { displayName: "Dana Lee", evidence });
    const dana = db.tables.people!.find((p) => p.display_name === "Dana Lee")!;
    await call(asRun(), "people.update", { personId: dana.id, provider: "email", externalId: "dana@x.com" });
    await call(asRun(), "people.update", { personId: cory.id, provider: "email", externalId: "cory@typo.com" });
    expect(await call(asRun(), "people.update", { personId: cory.id, provider: "email", replaces: "cory@typo.com", externalId: "dana@x.com" })).toMatchObject({ status: "refused", code: "identity_taken" });
    expect(db.tables.person_identities).toContainEqual(expect.objectContaining({ person_id: cory.id, external_id: "cory@typo.com" }));
  });

  it("is for one change at a time: add, replace or remove, never a mix", async () => {
    const { call, cory } = await withCory();
    const base = { personId: cory.id, provider: "slack" };
    for (const args of [
      base,
      { ...base, replaces: "U1" },
      { ...base, remove: "U1", externalId: "U2" },
      { ...base, remove: "U1", replaces: "U0" },
      { ...base, remove: "U1", handle: "cory" },
    ]) {
      const result = await call(asRun(), "people.update", args);
      expect(result).toMatchObject({ status: "invalid" });
      expect(JSON.stringify(result)).toContain("Give externalId to add an id");
    }
  });

  it("lets a person do it too, and counts a run's removes and replaces against its limit", async () => {
    const { call, cory } = await withCory();
    await call(asUser(), "people.update", { personId: cory.id, provider: "slack", externalId: "U1" });
    expect(await call(asUser(), "people.update", { personId: cory.id, provider: "slack", remove: "U1" })).toMatchObject({ status: "ok", output: { outcome: "removed" } });
    const capped = asRun([{ tool: "people.update", limits: { maxPerRun: 0 } }]);
    expect(await call(capped, "people.update", { personId: cory.id, provider: "slack", remove: "U1" })).toMatchObject({ status: "refused", code: "limit_reached" });
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

  it("keeps routine runs from approving or rejecting, even with the permission", async () => {
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
  const synthesis = (permissions: ReadonlyArray<AnyDraftToolPermission> = SYNTHESIS_PERMISSIONS) => runCaller({ ...runSpec(permissions, null), kind: "synthesis" });

  it("grants every registered people tool and context read/write without default call caps", () => {
    const tools = SYNTHESIS_PERMISSIONS.map((permission) => permission.tool);
    expect(tools).toEqual(expect.arrayContaining(["context.read", "context.write", ...DRAFT_TOOLS.filter((tool) => tool.name.startsWith("people.")).map((tool) => tool.name)]));
    for (const permission of SYNTHESIS_PERMISSIONS) expect((permission.limits as { maxPerRun?: number } | undefined)?.maxPerRun).toBeUndefined();
  });

  it("lets synthesis approve and reject within its workspace, attributing the decision to its run", async () => {
    const { call, db } = setup();
    await call(synthesis(), "people.create", { displayName: "Cory Banks", evidence });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    expect(await call(synthesis(), "people.reject", { personId: cory.id, reason: "Incorrect teammate" })).toMatchObject({ status: "ok" });
    expect(cory).toMatchObject({ status: "rejected", decided_by_user_id: null, evidence: { decidedByRunId: RUN, rejectionReason: "Incorrect teammate" } });
    expect(await call(synthesis(), "people.approve", { personId: cory.id })).toMatchObject({ status: "ok" });
    expect(cory.status).toBe("active");
    expect(cory.evidence).toMatchObject({ decidedByRunId: RUN });
    db.tables.people!.push({ id: "88888888-8888-4888-8888-888888888888", workspace_id: OTHER_WS, display_name: "Other workspace", status: "pending" });
    expect(await call(synthesis(), "people.approve", { personId: "88888888-8888-4888-8888-888888888888" })).toMatchObject({ status: "refused", code: "person_not_found" });
    expect(await call(synthesis([{ tool: "people.find" }]), "people.approve", { personId: cory.id })).toMatchObject({ status: "denied", code: "not_permitted" });
  });

  it("does not apply the routine fallback caps to synthesis, but honors an explicit cap", async () => {
    const { call, db } = setup();
    for (const tool of ["people.create", "people.update"]) {
      for (let i = 0; i < 100; i++) db.tables.agent_run_tool_calls!.push({ agent_run_id: RUN, tool_name: tool, status: "ok" });
    }
    expect(await call(synthesis(), "people.create", { displayName: "Cory Banks", evidence })).toMatchObject({ status: "ok" });
    const cory = db.tables.people!.find((p) => p.display_name === "Cory Banks")!;
    expect(await call(synthesis(), "people.update", { personId: cory.id, provider: "slack", externalId: "U_NEW", evidence })).toMatchObject({ status: "ok" });
    expect(await call(synthesis([{ tool: "people.create", limits: { maxPerRun: 1 } }]), "people.create", { displayName: "Other Person", evidence })).toMatchObject({ status: "refused", code: "limit_reached" });
  });
});
