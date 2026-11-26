import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { NotifyChannelId, NotifyMessage } from "draft-core/notify";
import { claudeCredentialRules } from "../../cloud-sessions/claude-credential";
import { CredentialError } from "../../credentials/crypto";
import { resolveCredential, saveCredential } from "../../credentials/harness-credential";
import type { NotifyChannel } from "../../notify/delivery/types";
import { clearCredentialAttention, notifyCredentialAttention, reportCredentialFailure } from "../../notify/product/credential-attention";
import { fakeClient, fakeDb } from "../routines/fake-client";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V2 = randomBytes(32).toString("base64");
});

const WS = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const SAVER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const SAVER_PERSON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_PERSON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function setup(credential: Record<string, unknown> = {}) {
  const db = fakeDb(
    {
      workspaces: [{ id: WS, team_id: TEAM }],
      users: [
        { id: SAVER, status: "active", primary_team_id: TEAM, organization_role: "member" },
        { id: ADMIN, status: "active", primary_team_id: TEAM, organization_role: "admin" },
      ],
      people: [
        { id: SAVER_PERSON, workspace_id: WS, display_name: "Uzo", user_id: SAVER, status: "active", affiliation: "member", notify_channels: ["slack"] },
        { id: ADMIN_PERSON, workspace_id: WS, display_name: "Ada", user_id: ADMIN, status: "active", affiliation: "member", notify_channels: ["slack"] },
      ],
      credentials: [{ id: CREDENTIAL, workspace_id: WS, provider: "claude_code", created_by_user_id: SAVER, updated_at: "2026-11-25T10:00:00Z", status: "revoked", ...credential }],
      notifications: [],
      notification_deliveries: [],
      person_identities: [],
      errors: [],
    },
    { unique: { notifications: [["workspace_id", "idempotency_key"]], notification_deliveries: [["id"]] }, uuidTables: ["notifications", "notification_deliveries"] },
  );
  const sent: Array<{ personId: string; message: NotifyMessage }> = [];
  const slack: NotifyChannel = { id: "slack", canReach: async () => true, send: async (person, message) => (sent.push({ personId: person.id, message }), { channel: "slack", status: "sent" }) };
  const channels = { slack } as unknown as Record<NotifyChannelId, NotifyChannel>;
  return { db, client: fakeClient(db), channels, sent };
}

describe("the notice that a login stopped working", () => {
  it("asks the person who saved the login to reconnect it", async () => {
    const { db, client, channels, sent } = setup();
    await notifyCredentialAttention(client, channels, WS, CREDENTIAL);
    expect(sent.map((item) => item.personId)).toEqual([SAVER_PERSON]);
    expect(db.tables.notifications).toHaveLength(1);
    expect(db.tables.notifications![0]).toMatchObject({ kind: "connection_attention", ref_type: "credential", ref_id: CREDENTIAL, needs_action: true, recipient_person_id: SAVER_PERSON });
  });

  it("sends one notice per failure episode, and a new one after the login is saved again", async () => {
    const { db, client, channels, sent } = setup();
    await notifyCredentialAttention(client, channels, WS, CREDENTIAL);
    await notifyCredentialAttention(client, channels, WS, CREDENTIAL);
    expect(db.tables.notifications).toHaveLength(1);
    expect(sent).toHaveLength(1);

    db.tables.credentials![0]!.updated_at = "2026-11-25T12:00:00Z";
    await notifyCredentialAttention(client, channels, WS, CREDENTIAL);
    expect(db.tables.notifications).toHaveLength(2);
  });

  it("goes to the workspace admins when nobody owns the login, or its owner is gone", async () => {
    for (const created_by_user_id of [null, "99999999-9999-4999-8999-999999999999"]) {
      const { db, client, channels } = setup({ created_by_user_id });
      await notifyCredentialAttention(client, channels, WS, CREDENTIAL);
      expect(db.tables.notifications!.map((row) => row.recipient_person_id)).toEqual([ADMIN_PERSON]);
    }
  });

  it("says nothing for a login that does not exist", async () => {
    const { db, client, channels } = setup();
    await notifyCredentialAttention(client, channels, WS, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(db.tables.notifications).toHaveLength(0);
  });

  it("closes the open notices of one login and leaves other notices alone", async () => {
    const { db, client } = setup();
    db.tables.notifications!.push(
      { id: "n1", workspace_id: WS, kind: "connection_attention", ref_type: "credential", ref_id: CREDENTIAL, state: "open" },
      { id: "n2", workspace_id: WS, kind: "connection_attention", ref_type: "credential", ref_id: "other", state: "open" },
      { id: "n3", workspace_id: WS, kind: "todo_routed", ref_type: null, ref_id: null, state: "open" },
    );
    await clearCredentialAttention(client, WS, CREDENTIAL);
    expect(db.tables.notifications!.map((row) => row.state)).toEqual(["done", "open", "open"]);
  });

  it("is closed by saving the login again, which also makes it usable", async () => {
    const { db, client } = setup();
    db.tables.credentials![0]!.id = "credentials-1";
    db.tables.notifications!.push({ id: "n1", workspace_id: WS, kind: "connection_attention", ref_type: "credential", ref_id: "credentials-1", state: "open" });
    const id = await saveCredential(client, WS, claudeCredentialRules, "sk-ant-oat01-new", SAVER);
    expect(id).toBe("credentials-1");
    expect(db.tables.notifications![0]!.state).toBe("done");
    expect((await resolveCredential(client, WS, claudeCredentialRules)).secret).toBe("sk-ant-oat01-new");
  });
});

describe("reporting a login failure", () => {
  it("stays quiet for a missing login, a login with no known id, and errors that are not about a login", async () => {
    const { db, client } = setup();
    await reportCredentialFailure(client, WS, new CredentialError("none", "missing", CREDENTIAL));
    await reportCredentialFailure(client, WS, new CredentialError("no id", "revoked"));
    await reportCredentialFailure(client, WS, new Error("network"));
    expect(db.tables.notifications).toHaveLength(0);
  });
});
