import { describe, expect, it, mock } from "bun:test";
import slackFixture from "./fixtures/slack-users-list.json";
import linearFixture from "./fixtures/linear-users.json";
import { fetchLinearUsers } from "../../ingestion/linear/users";
import { fetchSlackUsers } from "../../ingestion/slack/users";
import { addIdentity } from "../../people/match";
import { syncLinearIdentities } from "../../people/sync/linear";
import { syncPeople } from "../../people/sync";
import { syncSlackIdentities } from "../../people/sync/slack";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const CONNECTION = { id: "conn-1", workspace_id: WS, credential_id: "cred-1" };

const jsonResponse = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

const newDb = () =>
  fakeDb(
    {
      workspaces: [{ id: WS, team_id: TEAM }],
      users: [{ id: "u1", email: "uzo@example.com", display_name: "Uzo", status: "active", primary_team_id: TEAM }],
      people: [],
      person_identities: [],
      source_connections: [],
    },
    { unique: { people: [["workspace_id", "user_id"]], person_identities: [["workspace_id", "provider", "external_id"]] } },
  );

const slackDeps = (fetchUsers = () => fetchSlackUsers("xoxb-test", jsonResponse(slackFixture) as never)) => ({
  resolveCredential: async () => ({ bot_token: "xoxb-test" }),
  fetchUsers,
  recordWarning: mock(async () => {}),
});

describe("fetchSlackUsers", () => {
  it("keeps full members and drops bots, Slackbot, deleted users and guests", async () => {
    const { users, sawPeopleWithoutEmail } = await fetchSlackUsers("xoxb-test", jsonResponse(slackFixture) as never);
    expect(users.map((user) => user.id)).toEqual(["U001", "U002"]);
    expect(sawPeopleWithoutEmail).toBe(false);
  });

  it("says the email scope is missing when no member has an email", async () => {
    const stripped = { ...slackFixture, members: slackFixture.members.map((m) => ({ ...m, profile: { real_name: "x" } })) };
    const result = await fetchSlackUsers("xoxb-test", jsonResponse(stripped) as never);
    expect(result.sawPeopleWithoutEmail).toBe(true);
  });
});

describe("fetchLinearUsers", () => {
  it("keeps active, non-guest users", async () => {
    const users = await fetchLinearUsers("lin_api_x", jsonResponse(linearFixture) as never);
    expect(users.map((user) => user.id)).toEqual(["lin-1", "lin-2"]);
  });
});

describe("syncSlackIdentities", () => {
  it("adds a Slack identity to the member with that email and creates a person for a teammate with none", async () => {
    const db = newDb();
    const client = fakeClient(db);
    await syncPeople(client, WS, { resolveCredential: async () => ({}) });
    const counts = await syncSlackIdentities(client, CONNECTION, slackDeps());

    expect(counts).toEqual({ matched: 1, created: 1, known: 0, skipped: 0 });
    const uzo = db.tables.people!.find((person) => person.user_id === "u1")!;
    expect(db.tables.person_identities).toContainEqual(expect.objectContaining({ person_id: uzo.id, provider: "slack", external_id: "U001", status: "from_connection" }));
    const cory = db.tables.people!.find((person) => person.display_name === "Cory B")!;
    expect(cory).toMatchObject({ status: "active", created_by: "connection" });
    expect(cory.user_id ?? null).toBeNull();
    expect(db.tables.person_identities).toContainEqual(expect.objectContaining({ person_id: cory.id, provider: "email", external_id: "cory@example.com" }));
  });

  it("makes no duplicate on a second run", async () => {
    const db = newDb();
    const client = fakeClient(db);
    await syncPeople(client, WS, { resolveCredential: async () => ({}) });
    await syncSlackIdentities(client, CONNECTION, slackDeps());
    const snapshot = JSON.stringify(db.tables);
    const counts = await syncSlackIdentities(client, CONNECTION, slackDeps());
    expect(JSON.stringify(db.tables)).toBe(snapshot);
    expect(counts).toEqual({ matched: 0, created: 0, known: 2, skipped: 0 });
  });

  it("adds nothing and warns when Slack gives no emails", async () => {
    const db = newDb();
    const deps = slackDeps(async () => ({ users: [{ id: "U001", name: "Uzo", email: null }], sawPeopleWithoutEmail: true }));
    const counts = await syncSlackIdentities(fakeClient(db), CONNECTION, deps);
    expect(counts.skipped).toBe(1);
    expect(db.tables.people).toHaveLength(0);
    expect(deps.recordWarning).toHaveBeenCalledWith(CONNECTION, "slack_email_scope_missing", expect.any(String));
  });
});

describe("syncLinearIdentities", () => {
  it("matches by email and shares one person across Slack and Linear", async () => {
    const db = newDb();
    const client = fakeClient(db);
    await syncPeople(client, WS, { resolveCredential: async () => ({}) });
    await syncSlackIdentities(client, CONNECTION, slackDeps());
    const counts = await syncLinearIdentities(client, CONNECTION, {
      resolveCredential: async () => ({ api_token: "lin_api_x" }),
      fetchUsers: () => fetchLinearUsers("lin_api_x", jsonResponse(linearFixture) as never),
    });
    expect(counts).toEqual({ matched: 1, created: 1, known: 0, skipped: 0 });
    const uzo = db.tables.people!.find((person) => person.user_id === "u1")!;
    const providers = db.tables.person_identities!.filter((identity) => identity.person_id === uzo.id).map((identity) => identity.provider).sort();
    expect(providers).toEqual(["email", "linear", "slack"]);
  });
});

describe("addIdentity", () => {
  const seed = () => {
    const db = newDb();
    db.tables.people!.push({ id: "p1", workspace_id: WS }, { id: "p2", workspace_id: WS });
    return db;
  };

  it("never lowers a confirmed identity to a weaker one", async () => {
    const db = seed();
    db.tables.person_identities!.push({ id: "i1", workspace_id: WS, person_id: "p1", provider: "email", external_id: "a@x.com", status: "confirmed", handle: null });
    expect(await addIdentity(fakeClient(db), WS, "p1", { provider: "email", externalId: "a@x.com", status: "inferred" })).toBe("unchanged");
    expect(await addIdentity(fakeClient(db), WS, "p1", { provider: "email", externalId: "a@x.com", status: "from_connection" })).toBe("unchanged");
    expect(db.tables.person_identities![0]!.status).toBe("confirmed");
  });

  it("raises an inferred identity when a connection proves it", async () => {
    const db = seed();
    db.tables.person_identities!.push({ id: "i1", workspace_id: WS, person_id: "p1", provider: "slack", external_id: "U9", status: "inferred", handle: null });
    expect(await addIdentity(fakeClient(db), WS, "p1", { provider: "slack", externalId: "U9", status: "from_connection" })).toBe("raised");
    expect(db.tables.person_identities![0]!.status).toBe("from_connection");
  });

  it("leaves an identity that belongs to another person", async () => {
    const db = seed();
    db.tables.person_identities!.push({ id: "i1", workspace_id: WS, person_id: "p1", provider: "slack", external_id: "U9", status: "confirmed", handle: null });
    expect(await addIdentity(fakeClient(db), WS, "p2", { provider: "slack", externalId: "U9", status: "from_connection" })).toBe("taken");
    expect(db.tables.person_identities).toHaveLength(1);
  });
});
