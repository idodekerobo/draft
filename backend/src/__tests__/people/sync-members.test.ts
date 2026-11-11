import { describe, expect, it } from "bun:test";
import { syncMembers } from "../../people/sync-members";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const OTHER_TEAM = "33333333-3333-4333-8333-333333333333";

const newDb = () =>
  fakeDb(
    {
      workspaces: [{ id: WS, team_id: TEAM }],
      users: [
        { id: "u1", email: "Uzo@Example.com", display_name: "Uzo", status: "active", primary_team_id: TEAM },
        { id: "u2", email: "iza@example.com", display_name: null, status: "active", primary_team_id: TEAM },
        { id: "u3", email: "gone@example.com", display_name: "Gone", status: "disabled", primary_team_id: TEAM },
        { id: "u4", email: "other@example.com", display_name: "Other", status: "active", primary_team_id: OTHER_TEAM },
      ],
      people: [],
      person_identities: [],
    },
    { unique: { people: [["workspace_id", "user_id"]], person_identities: [["workspace_id", "provider", "external_id"]] } },
  );

describe("syncMembers", () => {
  it("makes an active person with a confirmed, lowercased email identity for each active team member", async () => {
    const db = newDb();
    await syncMembers(fakeClient(db), WS);

    expect(db.tables.people).toHaveLength(2);
    expect(db.tables.people).toEqual([
      expect.objectContaining({ workspace_id: WS, user_id: "u1", display_name: "Uzo", status: "active", created_by: "user" }),
      expect.objectContaining({ workspace_id: WS, user_id: "u2", display_name: "iza", status: "active", created_by: "user" }),
    ]);
    expect(db.tables.person_identities).toEqual([
      expect.objectContaining({ provider: "email", external_id: "uzo@example.com", status: "confirmed", person_id: db.tables.people![0]!.id }),
      expect.objectContaining({ provider: "email", external_id: "iza@example.com", status: "confirmed", person_id: db.tables.people![1]!.id }),
    ]);
  });

  it("creates nothing on a second call", async () => {
    const db = newDb();
    await syncMembers(fakeClient(db), WS);
    const snapshot = JSON.stringify(db.tables);
    await syncMembers(fakeClient(db), WS);
    expect(JSON.stringify(db.tables)).toBe(snapshot);
  });

  it("adds only the member who joined since the last call", async () => {
    const db = newDb();
    await syncMembers(fakeClient(db), WS);
    db.tables.users!.push({ id: "u5", email: "new@example.com", display_name: "New", status: "active", primary_team_id: TEAM });
    await syncMembers(fakeClient(db), WS);
    expect(db.tables.people).toHaveLength(3);
    expect(db.tables.person_identities).toHaveLength(3);
  });

  it("gives a disabled user, and a user on another team, nothing", async () => {
    const db = newDb();
    await syncMembers(fakeClient(db), WS);
    const userIds = db.tables.people!.map((person) => person.user_id);
    expect(userIds).not.toContain("u3");
    expect(userIds).not.toContain("u4");
  });

  it("leaves an existing person and their trusted identity as they are", async () => {
    const db = newDb();
    db.tables.people!.push({ id: "p1", workspace_id: WS, user_id: "u1", display_name: "Uzo (renamed)", status: "active", created_by: "user" });
    db.tables.person_identities!.push({ id: "i1", workspace_id: WS, person_id: "p1", provider: "email", external_id: "uzo@example.com", status: "from_connection" });
    await syncMembers(fakeClient(db), WS);
    expect(db.tables.people![0]).toMatchObject({ display_name: "Uzo (renamed)" });
    expect(db.tables.person_identities![0]).toMatchObject({ status: "from_connection" });
  });

  it("does nothing for an unknown workspace", async () => {
    const db = newDb();
    await syncMembers(fakeClient(db), "99999999-9999-4999-8999-999999999999");
    expect(db.tables.people).toHaveLength(0);
  });
});
