import { describe, expect, it } from "bun:test";
import type { NotifyChannelId, NotifyMessage } from "draft-core/notify";
import { failedSynthesisNotice } from "../../events/run-result";
import type { NotifyChannel } from "../../notify/delivery/types";
import { notifyAdminsOfFailedRun } from "../../notify/product/run-result";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const MEMBER_PERSON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_PERSON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup() {
  const db = fakeDb(
    {
      workspaces: [{ id: WS, team_id: TEAM }],
      users: [
        { id: MEMBER, status: "active", primary_team_id: TEAM, organization_role: "member" },
        { id: ADMIN, status: "active", primary_team_id: TEAM, organization_role: "admin" },
      ],
      people: [
        { id: MEMBER_PERSON, workspace_id: WS, display_name: "Uzo", user_id: MEMBER, status: "active", affiliation: "member", notify_channels: ["slack"] },
        { id: ADMIN_PERSON, workspace_id: WS, display_name: "Ada", user_id: ADMIN, status: "active", affiliation: "member", notify_channels: ["slack"] },
      ],
      notifications: [], notification_deliveries: [], person_identities: [], errors: [],
    },
    { unique: { notifications: [["workspace_id", "idempotency_key"]], notification_deliveries: [["id"]] }, uuidTables: ["notifications", "notification_deliveries"] },
  );
  const sent: Array<{ personId: string; message: NotifyMessage }> = [];
  const slack: NotifyChannel = { id: "slack", canReach: async () => true, send: async (person, message) => (sent.push({ personId: person.id, message }), { channel: "slack", status: "sent" }) };
  return { db, client: fakeClient(db), channels: { slack } as unknown as Record<NotifyChannelId, NotifyChannel>, sent };
}

describe("the notice that a context update failed", () => {
  it("goes to the workspace's admins as a Needs you item for the run, and to nobody else", async () => {
    const { db, client, channels, sent } = setup();
    await notifyAdminsOfFailedRun(client, channels, { id: RUN, workspace_id: WS });
    expect(sent.map((item) => item.personId)).toEqual([ADMIN_PERSON]);
    expect(db.tables.notifications![0]).toMatchObject({ kind: "run_result", ref_type: "agent_run", ref_id: RUN, needs_action: true, recipient_person_id: ADMIN_PERSON });
  });

  it("sends one notice per run however many times it is told", async () => {
    const { db, client, channels, sent } = setup();
    await notifyAdminsOfFailedRun(client, channels, { id: RUN, workspace_id: WS });
    await notifyAdminsOfFailedRun(client, channels, { id: RUN, workspace_id: WS });
    expect(db.tables.notifications).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("is sent only for a failed synthesis run, never for a success, a routine or a step", async () => {
    const { db, client } = setup();
    const base = { id: RUN, workspace_id: WS, outcome: null, on_behalf_of_user_id: null };
    await failedSynthesisNotice(client, { ...base, kind: "synthesis", status: "succeeded" });
    await failedSynthesisNotice(client, { ...base, kind: "routine", status: "failed" });
    await failedSynthesisNotice(client, { ...base, kind: "step", status: "failed" });
    expect(db.tables.notifications).toHaveLength(0);
  });
});
