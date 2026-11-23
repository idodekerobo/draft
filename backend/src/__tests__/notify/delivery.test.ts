import { describe, expect, it } from "bun:test";
import type { NotifyChannelId } from "draft-core/notify";
import { parsePersonId, parseWorkspaceId } from "draft-core/run-spec";
import { deliverNotification } from "../../notify/delivery/deliver";
import { DeliveryUncertainError, markReachable, type NotifyChannel } from "../../notify/delivery/types";
import { fakeClient, fakeDb } from "../routines/fake-client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const person = markReachable({ id: parsePersonId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), workspaceId: parseWorkspaceId(workspaceId), displayName: "Ada", userId: "user", notifyChannels: ["slack", "email"] });
const input = { text: "Hello", attribution: "Draft", idempotencyKey: "event-1", origin: { senderUserId: "user", agentRunId: null, scheduledTaskId: null } };
function setup() {
  const db = fakeDb({ notifications: [], notification_deliveries: [], errors: [] }, {
    unique: { notifications: [["workspace_id", "idempotency_key"]], notification_deliveries: [["id"]] },
    defaults: { notification_deliveries: { status: "queued", error_code: null } },
    uuidTables: ["notifications"],
  });
  const sent: Array<{ channel: string; deliveryId?: string; subject?: string }> = [];
  const channel = (id: NotifyChannelId): NotifyChannel => ({ id, canReach: async () => true, send: async (_person, message, context) => {
    sent.push({ channel: id, deliveryId: context?.deliveryId, subject: message.subject });
    return { channel: id, status: "sent" };
  } });
  const channels = { slack: channel("slack"), email: channel("email") };
  return { db, sent, channels, client: fakeClient(db) };
}

describe("durable notification delivery", () => {
  it("claims each channel atomically across concurrent same-key sends", async () => {
    const s = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => deliverNotification(s.client, s.channels, person, input)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(s.db.tables.notifications).toHaveLength(1);
    expect(s.db.tables.notification_deliveries).toHaveLength(2);
    expect(s.sent.map((row) => row.channel).sort()).toEqual(["email", "slack"]);
    expect(new Set(s.sent.map((row) => row.deliveryId)).size).toBe(2);
  });

  it("preserves queued and terminal channel states on replay without sending", async () => {
    const s = setup();
    await deliverNotification(s.client, s.channels, person, input);
    for (const status of ["queued", "delayed", "delivered", "bounced", "complained", "failed"] as const) {
      s.db.tables.notification_deliveries[0]!.status = status;
      const result = await deliverNotification(s.client, s.channels, person, input);
      expect(result).toMatchObject({ ok: true, results: [{ channel: "slack", status }, { channel: "email", status: "sent" }] });
    }
    expect(s.sent).toHaveLength(2);
  });

  it("does not resend when the saved-delivery query fails", async () => {
    const s = setup();
    await deliverNotification(s.client, s.channels, person, input);
    const broken = new Proxy(s.client, { get(target, key, receiver) {
      if (key !== "from") return Reflect.get(target, key, receiver);
      return (table: string) => {
        if (table !== "notification_deliveries") return target.from(table);
        const query = { select: () => query, eq: () => query, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: new Error("read unavailable") }).then(resolve) };
        return query;
      };
    } });
    await expect(deliverNotification(broken, s.channels, person, input)).rejects.toThrow("read unavailable");
    expect(s.sent).toHaveLength(2);
  });

  it("retains a sent result when the next channel cannot be recorded", async () => {
    const s = setup();
    const broken = new Proxy(s.client, { get(target, key, receiver) {
      if (key !== "from") return Reflect.get(target, key, receiver);
      return (table: string) => {
        const query = target.from(table);
        if (table !== "notification_deliveries") return query;
        return new Proxy(query, { get(q, property, r) {
          if (property !== "insert") return Reflect.get(q, property, r);
          return (row: { channel: string }) => row.channel === "email"
            ? { select: () => ({ single: async () => ({ data: null, error: new Error("record unavailable") }) }) }
            : q.insert(row);
        } });
      };
    } });
    expect(await deliverNotification(broken, s.channels, person, input)).toMatchObject({ ok: true, results: [{ channel: "slack", status: "sent" }, { channel: "email", status: "failed", code: "recording_error" }] });
    expect(s.sent.map((row) => row.channel)).toEqual(["slack"]);
    expect(await deliverNotification(s.client, s.channels, person, input)).toMatchObject({ ok: true, results: [{ channel: "slack", status: "sent" }, { channel: "email", status: "sent" }] });
    expect(s.sent.map((row) => row.channel)).toEqual(["slack", "email"]);
  });

  it("keeps uncertain provider acceptance queued and never blindly resends it", async () => {
    const s = setup();
    let attempts = 0;
    s.channels.email.send = async () => { attempts++; throw new DeliveryUncertainError(new Error("timeout")); };
    expect(await deliverNotification(s.client, s.channels, person, input)).toMatchObject({ ok: true, results: [{ channel: "slack", status: "sent" }, { channel: "email", status: "queued" }] });
    expect(await deliverNotification(s.client, s.channels, person, input)).toMatchObject({ ok: true, results: [{ channel: "slack", status: "sent" }, { channel: "email", status: "queued" }] });
    expect(attempts).toBe(1);
    expect(s.db.tables.notification_deliveries[1]).toMatchObject({ status: "queued", error_code: "delivery_unknown" });
  });

  it("does not return another sender's private notification through key reuse", async () => {
    const s = setup();
    await deliverNotification(s.client, s.channels, person, input);
    expect(await deliverNotification(s.client, s.channels, person, { ...input, origin: { ...input.origin, senderUserId: "someone-else" } })).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(s.sent).toHaveLength(2);
  });

  it("stores exactly the subject handed to the email channel", async () => {
    const s = setup();
    await deliverNotification(s.client, s.channels, person, input);
    expect(s.db.tables.notifications[0]!.subject).toBe("Draft: New message");
    expect(s.sent.find((row) => row.channel === "email")!.subject).toBe(String(s.db.tables.notifications[0]!.subject));
  });
});
