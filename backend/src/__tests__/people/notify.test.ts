import { describe, expect, it, mock } from "bun:test";
import type { ChannelSendResult, NotifyChannelId, NotifyMessage } from "draft-core/notify";
import { parseAgentRunId, parseContextVersionId, parsePersonId, parseUserId, parseWorkspaceId, parseScheduledTaskId, parseIsoTimestamp, type AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller, SYNTHESIS_PERMISSIONS, type AnyDraftToolPermission, type ToolCaller } from "draft-core/tools";
import { createPeopleTools } from "../../metaharness/tools/definitions/people";
import { invokeTool } from "../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../metaharness/tools/tool-registry";
import { markReachable, type NotifyChannel } from "../../notify/types";
import { sendNotification } from "../../notify/send";
import { renderSlackText, slackChannel } from "../../notify/slack";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";
const UZO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IZA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CORY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ADA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const newDb = () =>
  fakeDb(
    {
      workspaces: [{ id: WS, team_id: TEAM }],
      users: [
        { id: OWNER, email: "uzo@example.com", display_name: "Uzo", status: "active", primary_team_id: TEAM, organization_role: "member" },
        { id: ADMIN, email: "ada@example.com", display_name: "Ada", status: "active", primary_team_id: TEAM, organization_role: "admin" },
      ],
      people: [
        { id: UZO, workspace_id: WS, display_name: "Uzo", user_id: OWNER, status: "active", affiliation: "member", notify_channels: ["slack"] },
        { id: IZA, workspace_id: WS, display_name: "Iza", user_id: null, status: "active", affiliation: "member", notify_channels: ["slack"] },
        { id: CORY, workspace_id: WS, display_name: "Pat", user_id: null, status: "pending", affiliation: "member", notify_channels: ["slack"] },
        { id: CLIENT, workspace_id: WS, display_name: "Client", user_id: null, status: "active", affiliation: "external", notify_channels: ["slack"] },
        { id: ADA, workspace_id: WS, display_name: "Ada", user_id: ADMIN, status: "active", affiliation: "member", notify_channels: ["slack"] },
      ],
      person_identities: [],
      connections: [],
      source_items: [],
      scheduled_tasks: [{ id: TASK, workspace_id: WS, config_json: { title: "Meeting follow-up" } }],
      agent_run_tool_calls: [],
      errors: [],
      notifications: [],
      notification_deliveries: [],
      agent_runs: [{ id: RUN, workspace_id: WS, scheduled_task_id: TASK }],
    },
    { unique: { people: [["workspace_id", "user_id"]], person_identities: [["workspace_id", "provider", "external_id"]], notifications: [["workspace_id", "idempotency_key"]] }, uuidTables: ["people", "notifications", "notification_deliveries"] },
  );

function recordingChannel(result: ChannelSendResult = { channel: "slack", status: "sent" }, reachable = true) {
  const sent: Array<{ personId: string; message: NotifyMessage }> = [];
  const channel: NotifyChannel = {
    id: "slack",
    canReach: async () => reachable,
    send: async (person, message) => {
      sent.push({ personId: person.id, message });
      return result;
    },
  };
  return { channel, sent };
}

/** A fake client whose inserts into one table fail, as a database outage would. */
function clientFor(db: ReturnType<typeof newDb>, failInsertInto?: string) {
  const client = fakeClient(db);
  if (!failInsertInto) return client;
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const query = target.from(table);
        if (table !== failInsertInto) return query;
        return new Proxy(query, { get: (q, p, r) => (p === "insert" ? () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "db down" } }) }) }) : Reflect.get(q, p, r)) });
      };
    },
  });
}

function setup(options: { db?: ReturnType<typeof newDb>; channel?: NotifyChannel; email?: NotifyChannel; failInsertInto?: string } = {}) {
  const db = options.db ?? newDb();
  const recorder = recordingChannel();
  const channel = options.channel ?? recorder.channel;
  const registry = new ToolRegistry(createPeopleTools(clientFor(db, options.failInsertInto), { channels: { slack: channel, ...(options.email ? { email: options.email } : {}) } as Record<NotifyChannelId, NotifyChannel> }));
  const call = (caller: ToolCaller, tool: string, args: unknown) => invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, tool, args);
  return { db, call, sent: recorder.sent };
}

const runSpec = (permissions: ReadonlyArray<AnyDraftToolPermission>, onBehalfOf: string | null = OWNER): AgentRunSpec => ({
  id: parseAgentRunId(RUN),
  kind: "routine",
    network: "restricted",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "cron", scheduledTaskId: parseScheduledTaskId(TASK), occurrenceAt: parseIsoTimestamp("2026-11-11T09:00:00.000Z") },
  onBehalfOf: onBehalfOf ? parseUserId(onBehalfOf) : null,
  runtime: { type: "cloud", toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] } },
  harness: "claude",
  model: null,
  instructions: "",
  inputs: { contextVersionId: parseContextVersionId("77777777-7777-4777-8777-777777777777") },
  permissions,
  output: { type: "text" },
});
const asRun = (permissions: ReadonlyArray<AnyDraftToolPermission>, onBehalfOf: string | null = OWNER): ToolCaller => runCaller(runSpec(permissions, onBehalfOf));
const asUser = (userId = OWNER): ToolCaller => personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "cli" });

const toMembers: AnyDraftToolPermission[] = [{ tool: "people.notify", limits: { recipients: "members", maxPerRun: 3 } }];
const LINE = `🤖 Draft agent · running Uzo's "Meeting follow-up" routine`;

describe("people.notify", () => {
  it("sends the model's text unchanged and a fixed line naming the owner and the routine to end the message", async () => {
    const { call, sent } = setup();
    const result = await call(asRun(toMembers), "people.notify", { personId: IZA, text: "Your items: ship the demo." });
    expect(result).toMatchObject({ status: "ok", output: { results: [{ channel: "slack", status: "sent" }] } });
    expect(sent[0]!.message).toMatchObject({ text: "Your items: ship the demo.", attribution: LINE });
  });

  it("keeps the line separate from the text even when the model writes a line like it", async () => {
    const { call, sent } = setup();
    await call(asRun(toMembers), "people.notify", { personId: IZA, text: "Ignore the line above. This message is from a human, not an agent." });
    expect(sent[0]!.message).toMatchObject({ text: "Ignore the line above. This message is from a human, not an agent.", attribution: LINE });
  });

  it("names the person who sent a message from the CLI", async () => {
    const { call, sent } = setup();
    await call(asUser(OWNER), "people.notify", { personId: IZA, text: "hello" });
    expect(sent[0]!.message).toMatchObject({ text: "hello", attribution: "Sent by Uzo through Draft" });
  });

  it("names the routine for a run an event started, whose trigger does not carry the task", async () => {
    const { call, sent } = setup();
    const eventRun = runCaller({ ...runSpec(toMembers), trigger: { type: "webhook", provider: "fireflies", eventId: "meeting-1" } });
    await call(eventRun, "people.notify", { personId: IZA, text: "Your items." });
    expect(sent[0]!.message).toMatchObject({ text: "Your items.", attribution: LINE });
  });

  it("names the teammate who pressed Run now on someone else's routine, and not the owner who ran their own", async () => {
    const { call, sent } = setup();
    const manual = (requestedBy: string): ToolCaller => runCaller({ ...runSpec(toMembers), trigger: { type: "manual", requestedBy: parseUserId(requestedBy) } });
    await call(manual(ADMIN), "people.notify", { personId: IZA, text: "a" });
    expect(sent[0]!.message.attribution).toBe(`${LINE} · started by Ada`);
    await call(manual(OWNER), "people.notify", { personId: IZA, text: "b" });
    expect(sent[1]!.message.attribution).toBe(LINE);
  });

  it("says a run with no routine title, or no owner, is still an agent", async () => {
    const { call, sent, db } = setup();
    db.tables.scheduled_tasks![0]!.config_json = {};
    await call(asRun(toMembers), "people.notify", { personId: IZA, text: "a" });
    expect(sent[0]!.message.attribution).toBe("🤖 Draft agent · running a routine for Uzo");
    await call(asRun([{ tool: "people.notify", limits: { recipients: "members" } }], null), "people.notify", { personId: IZA, text: "b" });
    expect(sent[1]!.message.attribution).toBe("🤖 Draft agent · routine run");
  });

  it("refuses the whole call, with not_allowed, for a missing, pending or external person", async () => {
    const { call, sent } = setup();
    expect(await call(asRun(toMembers), "people.notify", { personId: "99999999-9999-4999-8999-999999999999", text: "x" })).toMatchObject({ status: "refused", code: "not_allowed" });
    expect(await call(asRun(toMembers), "people.notify", { personId: CORY, text: "x" })).toMatchObject({ status: "refused", code: "not_allowed", message: expect.stringContaining("not active") });
    expect(await call(asRun(toMembers), "people.notify", { personId: CLIENT, text: "x" })).toMatchObject({ status: "refused", code: "not_allowed", message: expect.stringContaining("teammates") });
    expect(sent).toHaveLength(0);
  });

  it("refuses a person in another workspace", async () => {
    const { call, db, sent } = setup();
    db.tables.people!.push({ id: "99999999-9999-4999-8999-999999999999", workspace_id: "00000000-0000-4000-8000-000000000000", display_name: "Elsewhere", status: "active", affiliation: "member", notify_channels: ["slack"] });
    expect(await call(asRun(toMembers), "people.notify", { personId: "99999999-9999-4999-8999-999999999999", text: "x" })).toMatchObject({ status: "refused", code: "not_allowed" });
    expect(sent).toHaveLength(0);
  });

  it("limits recipients: self means the person the run works for", async () => {
    const { call, sent } = setup();
    const self: AnyDraftToolPermission[] = [{ tool: "people.notify", limits: { recipients: "self" } }];
    expect(await call(asRun(self), "people.notify", { personId: UZO, text: "x" })).toMatchObject({ status: "ok" });
    expect(await call(asRun(self), "people.notify", { personId: IZA, text: "x" })).toMatchObject({ status: "refused", code: "not_allowed" });
    expect(await call(asRun(self, null), "people.notify", { personId: UZO, text: "x" })).toMatchObject({ status: "refused", code: "not_allowed" });
    expect(sent).toHaveLength(1);
  });

  it("limits recipients to a named list", async () => {
    const { call } = setup();
    const named: AnyDraftToolPermission[] = [{ tool: "people.notify", limits: { recipients: [parsePersonId(IZA)] } }];
    expect(await call(asRun(named), "people.notify", { personId: IZA, text: "x" })).toMatchObject({ status: "ok" });
    expect(await call(asRun(named), "people.notify", { personId: UZO, text: "x" })).toMatchObject({ status: "refused", code: "not_allowed" });
  });

  it("treats a permission with no recipients as self, the narrowest", async () => {
    const { call } = setup();
    expect(await call(asRun([{ tool: "people.notify" }]), "people.notify", { personId: IZA, text: "x" })).toMatchObject({ status: "refused", code: "not_allowed" });
  });

  it("stops a run at maxPerRun with limit_reached", async () => {
    const { call, db, sent } = setup();
    for (let i = 0; i < 3; i += 1) db.tables.agent_run_tool_calls!.push({ agent_run_id: RUN, tool_name: "people.notify", status: "ok" });
    expect(await call(asRun(toMembers), "people.notify", { personId: IZA, text: "x" })).toMatchObject({ status: "refused", code: "limit_reached" });
    expect(sent).toHaveLength(0);
  });

  it("does not let a run without the permission call it", async () => {
    const { call } = setup();
    expect(await call(asRun([{ tool: "people.find" }]), "people.notify", { personId: IZA, text: "x" })).toMatchObject({ status: "denied", code: "not_permitted" });
  });

  it("uses the person's own channels when none are named, and passes a named channel through", async () => {
    const send = mock(async (_person: unknown, _message: NotifyMessage) => ({ channel: "slack", status: "sent" }) as ChannelSendResult);
    const channel: NotifyChannel = { id: "slack", canReach: async () => true, send };
    const { call } = setup({ channel });
    await call(asUser(), "people.notify", { personId: IZA, text: "x" });
    await call(asUser(), "people.notify", { personId: IZA, text: "x", channels: ["slack"], link: "https://app.example/items" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ link: "https://app.example/items" });
  });

  it("reports not_reachable for a person Slack cannot reach, without failing the call", async () => {
    const { channel } = recordingChannel({ channel: "slack", status: "sent" }, false);
    const { call } = setup({ channel });
    expect(await call(asUser(), "people.notify", { personId: IZA, text: "x" })).toMatchObject({ status: "ok", output: { results: [{ channel: "slack", status: "failed", code: "not_reachable" }] } });
  });
});

function emailRecorder(outcome: ChannelSendResult & { providerMessageId?: string } = { channel: "email" as NotifyChannelId, status: "sent", providerMessageId: "em_1" }) {
  const sent: Array<{ message: NotifyMessage; deliveryId?: string }> = [];
  const channel: NotifyChannel = { id: "email" as NotifyChannelId, canReach: async () => true, send: async (_person, message, context) => { sent.push({ message, deliveryId: context?.deliveryId }); return outcome; } };
  return { channel, sent };
}

describe("notification records", () => {
  it("saves the agent's own text, private, with its sender and origin, and one sent delivery per channel", async () => {
    const { channel: email, sent } = emailRecorder();
    const db = newDb();
    const { call } = setup({ db, email });
    const out = await call(asRun(toMembers), "people.notify", { personId: UZO, text: "Your items.", subject: "Draft: Meeting follow-ups", channels: ["slack", "email"] });
    expect(out).toMatchObject({ status: "ok", output: { results: [{ channel: "slack", status: "sent" }, { channel: "email", status: "sent" }] } });
    const notificationId = (out as { output: { notificationId: string } }).output.notificationId;
    expect(db.tables.notifications).toHaveLength(1);
    expect(db.tables.notifications![0]).toMatchObject({ id: notificationId, recipient_person_id: UZO, sender_user_id: OWNER, kind: "message", subject: "Meeting follow-ups", body_text: "Your items.", visibility: "private", agent_run_id: RUN, scheduled_task_id: TASK });
    expect(db.tables.notifications![0]!.body_text).not.toContain("Draft agent");
    expect(db.tables.notification_deliveries!.map((row) => [row.channel, row.status])).toEqual([["slack", "sent"], ["email", "sent"]]);
    expect(db.tables.notification_deliveries![1]).toMatchObject({ provider_message_id: "em_1", attempt_count: 1 });
    expect(sent[0]!.deliveryId).toBe(db.tables.notification_deliveries![1]!.id as string);
    expect(JSON.stringify(out)).not.toContain("em_1");
  });

  it("makes the stored text and subject from html and the text", async () => {
    const { channel: email } = emailRecorder();
    const db = newDb();
    const { call } = setup({ db, email });
    await call(asUser(), "people.notify", { personId: IZA, html: "<p>Hello <b>there</b></p>", channels: ["email"] });
    expect(db.tables.notifications![0]).toMatchObject({ body_text: "Hello there", body_html: "<p>Hello <b>there</b></p>", subject: "Hello there", sender_user_id: OWNER, agent_run_id: null });
  });

  it("refuses a call with no body", async () => {
    const db = newDb();
    const { call } = setup({ db });
    expect(await call(asUser(), "people.notify", { personId: IZA, subject: "x" })).toMatchObject({ status: "refused", code: "invalid_input" });
    expect(db.tables.notifications).toHaveLength(0);
  });

  it("marks a delivery failed with a bounded, redacted detail when a channel throws", async () => {
    const broken: NotifyChannel = { id: "slack", canReach: async () => true, send: async () => { throw new Error(`token=abc123 ${"x".repeat(600)}`); } };
    const db = newDb();
    const { call } = setup({ db, channel: broken });
    await call(asUser(), "people.notify", { personId: IZA, text: "x" });
    const row = db.tables.notification_deliveries![0]!;
    expect(row).toMatchObject({ status: "failed", error_code: "provider_error" });
    expect(String(row.error_detail).length).toBeLessThanOrEqual(500);
    expect(String(row.error_detail)).not.toContain("abc123");
  });

  it("records a channel that cannot reach the person as a failed delivery", async () => {
    const { channel } = recordingChannel({ channel: "slack", status: "sent" }, false);
    const db = newDb();
    const { call } = setup({ db, channel });
    await call(asUser(), "people.notify", { personId: IZA, text: "x" });
    expect(db.tables.notification_deliveries![0]).toMatchObject({ status: "failed", error_code: "not_reachable", attempt_count: 0 });
  });

  it("returns the same notification and sends nothing new for the same key and content", async () => {
    const { call, sent, db } = setup();
    const first = await call(asUser(), "people.notify", { personId: IZA, text: "once", idempotencyKey: "meeting-1" });
    const second = await call(asUser(), "people.notify", { personId: IZA, text: "once", idempotencyKey: "meeting-1" });
    expect((second as { output: unknown }).output).toEqual((first as { output: unknown }).output);
    expect(sent).toHaveLength(1);
    expect(db.tables.notifications).toHaveLength(1);
    expect(db.tables.notification_deliveries).toHaveLength(1);
  });

  it("refuses the same key with different content or another recipient", async () => {
    const { call, sent } = setup();
    await call(asUser(), "people.notify", { personId: IZA, text: "once", idempotencyKey: "k" });
    expect(await call(asUser(), "people.notify", { personId: IZA, text: "changed", idempotencyKey: "k" })).toMatchObject({ status: "refused", code: "idempotency_conflict" });
    expect(await call(asUser(), "people.notify", { personId: UZO, text: "once", idempotencyKey: "k" })).toMatchObject({ status: "refused", code: "idempotency_conflict" });
    expect(sent).toHaveLength(1);
  });

  it("sends only the channels a saved notification has no delivery for", async () => {
    const { channel: email, sent: emailSent } = emailRecorder();
    const slack = recordingChannel();
    const db = newDb();
    const { call } = setup({ db, channel: slack.channel, email });
    await call(asUser(), "people.notify", { personId: IZA, text: "hi", idempotencyKey: "k", channels: ["slack"] });
    const hash = db.tables.notifications![0]!.content_hash;
    // The retry asks for both channels, so its content differs and is refused. Rebuild the saved row as if the first try had asked for both and stopped after Slack.
    db.tables.notifications![0]!.content_hash = (await import("node:crypto")).createHash("sha256").update(JSON.stringify([IZA, "hi", "hi", null, null, ["email", "slack"]])).digest("hex");
    expect(hash).not.toBe(db.tables.notifications![0]!.content_hash);
    const retry = await call(asUser(), "people.notify", { personId: IZA, text: "hi", idempotencyKey: "k", channels: ["slack", "email"] });
    expect(retry).toMatchObject({ status: "ok", output: { results: [{ channel: "slack", status: "sent" }, { channel: "email", status: "sent" }] } });
    expect(slack.sent).toHaveLength(1);
    expect(emailSent).toHaveLength(1);
    expect(db.tables.notification_deliveries).toHaveLength(2);
  });

  it("derives a key for a run so an identical message in one run is saved once, and not for a person", async () => {
    const run = setup();
    await run.call(asRun(toMembers), "people.notify", { personId: IZA, text: "same" });
    await run.call(asRun(toMembers), "people.notify", { personId: IZA, text: "same" });
    expect(run.db.tables.notifications).toHaveLength(1);
    expect(run.sent).toHaveLength(1);
    const person = setup();
    await person.call(asUser(), "people.notify", { personId: IZA, text: "same" });
    await person.call(asUser(), "people.notify", { personId: IZA, text: "same" });
    expect(person.db.tables.notifications).toHaveLength(2);
  });

  it("sends nothing and logs when the notification cannot be saved", async () => {
    const db = newDb();
    const { call, sent } = setup({ db, failInsertInto: "notifications" });
    expect(await call(asUser(), "people.notify", { personId: IZA, text: "x" })).toMatchObject({ status: "refused", code: "notify_failed" });
    expect(sent).toHaveLength(0);
    expect(db.tables.errors!.some((row) => (row.detail_json as { code?: string }).code === "notify_record_failed")).toBe(true);
  });
});

describe("people.notification_status", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  function statusSetup(responses: Array<Response | Error>, key: string | undefined = "re_status") {
    const { channel: email } = emailRecorder();
    const db = newDb();
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch;
    const registry = new ToolRegistry(createPeopleTools(fakeClient(db), { channels: { slack: recordingChannel().channel, email } as Record<NotifyChannelId, NotifyChannel>, statusApiKey: () => key, resend: { fetchFn } }));
    const call = (caller: ToolCaller, tool: string, args: unknown) => invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, tool, args);
    return { db, call, calls };
  }
  const sendEmail = async (s: ReturnType<typeof statusSetup>, caller: ToolCaller = asUser()) =>
    ((await s.call(caller, "people.notify", { personId: UZO, text: "hi", channels: ["email"] })) as { output: { notificationId: string } }).output.notificationId;

  it("refreshes a sent email from the provider and saves the new status", async () => {
    const s = statusSetup([json({ id: "em_1", last_event: "delivered" })]);
    const notificationId = await sendEmail(s);
    const out = await s.call(asUser(), "people.notification_status", { notificationId });
    expect(out).toMatchObject({ status: "ok", output: { notificationId, refreshed: true, deliveries: [{ channel: "email", status: "delivered" }] } });
    expect(s.calls).toEqual(["https://api.resend.com/emails/em_1"]);
    expect(s.db.tables.notification_deliveries![0]).toMatchObject({ status: "delivered" });
    expect(JSON.stringify(out)).not.toContain("em_1");
  });

  it("never moves a status back and does not ask again for a final one", async () => {
    const s = statusSetup([json({ id: "em_1", last_event: "bounced" }), json({ id: "em_1", last_event: "delivered" })]);
    const notificationId = await sendEmail(s);
    await s.call(asUser(), "people.notification_status", { notificationId });
    const again = await s.call(asUser(), "people.notification_status", { notificationId });
    expect(again).toMatchObject({ output: { deliveries: [{ status: "bounced" }] } });
    expect(s.calls).toHaveLength(1);
  });

  it("shows the saved status and logs when the provider cannot be reached or there is no status key", async () => {
    const down = statusSetup([json({ name: "restricted_api_key" }, 401)]);
    const id = await sendEmail(down);
    expect(await down.call(asUser(), "people.notification_status", { notificationId: id })).toMatchObject({ status: "ok", output: { refreshed: false, deliveries: [{ status: "sent" }] } });
    expect(down.db.tables.errors!.some((row) => (row.detail_json as { code?: string }).code === "notify_status_refresh_failed")).toBe(true);
    const none = statusSetup([], undefined);
    const id2 = await sendEmail(none);
    expect(await none.call(asUser(), "people.notification_status", { notificationId: id2 })).toMatchObject({ output: { refreshed: false, deliveries: [{ status: "sent" }] } });
  });

  it("lets the sender and the recipient read a private notification, and nobody else", async () => {
    const s = statusSetup([json({ id: "em_1", last_event: "sent" }), json({ id: "em_1", last_event: "sent" })]);
    const id = await sendEmail(s, asUser(OWNER));
    const asRecipient = asUser(OWNER);
    expect(await s.call(asRecipient, "people.notification_status", { notificationId: id })).toMatchObject({ status: "ok" });
    expect(await s.call(asUser(ADMIN), "people.notification_status", { notificationId: id })).toMatchObject({ status: "refused", code: "not_found" });
    expect(await s.call(asUser(), "people.notification_status", { notificationId: "99999999-9999-4999-8999-999999999999" })).toMatchObject({ status: "refused", code: "not_found" });
  });

  it("does not show a notification from another workspace", async () => {
    const s = statusSetup([]);
    const id = await sendEmail(s);
    s.db.tables.notifications![0]!.workspace_id = "99999999-9999-4999-8999-999999999999";
    expect(await s.call(asUser(), "people.notification_status", { notificationId: id })).toMatchObject({ status: "refused", code: "not_found" });
  });

  it("lets the run that sent it, and anyone on a shared notification, read it", async () => {
    const s = statusSetup([json({ id: "em_1", last_event: "sent" }), json({ id: "em_1", last_event: "sent" })]);
    const withStatus = [...toMembers, { tool: "people.notification_status" } as AnyDraftToolPermission];
    const id = await sendEmail(s, asRun(withStatus, null));
    expect(await s.call(asRun(withStatus, null), "people.notification_status", { notificationId: id })).toMatchObject({ status: "ok" });
    s.db.tables.notifications![0]!.visibility = "shared";
    expect(await s.call(asUser(ADMIN), "people.notification_status", { notificationId: id })).toMatchObject({ status: "ok" });
  });
});

describe("notify error logging", () => {
  it("logs a thrown channel error to the errors table without the message body", async () => {
    const broken: NotifyChannel = { id: "slack", canReach: async () => true, send: async () => { throw new Error("slack_send_failed: channel_not_found"); } };
    const db = newDb();
    const { call } = setup({ channel: broken, db });
    const out = await call(asUser(), "people.notify", { personId: IZA, text: "secret launch plan" });
    expect(out).toMatchObject({ status: "ok", output: { results: [{ channel: "slack", status: "failed", code: "provider_error" }] } });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ workspace_id: WS, operation: "execution", agent_run_id: null });
    expect(JSON.stringify(db.tables.errors![0])).not.toContain("secret launch plan");
    expect(db.tables.errors![0]!.detail_json).toMatchObject({ code: "notify_send_failed", channel: "slack", personId: IZA });
  });

  it("links the logged error to the run that sent", async () => {
    const broken: NotifyChannel = { id: "slack", canReach: async () => true, send: async () => { throw new Error("boom"); } };
    const db = newDb();
    const { call } = setup({ channel: broken, db });
    await call(runCaller({ ...runSpec([{ tool: "people.notify", limits: { recipients: "members" } } as AnyDraftToolPermission]) }), "people.notify", { personId: IZA, text: "x" });
    expect(db.tables.errors![0]).toMatchObject({ agent_run_id: RUN });
  });

  it("does not log not_reachable", async () => {
    const { channel } = recordingChannel({ channel: "slack", status: "sent" }, false);
    const db = newDb();
    const { call } = setup({ channel, db });
    await call(asUser(), "people.notify", { personId: IZA, text: "x" });
    expect(db.tables.errors).toHaveLength(0);
  });
});

describe("sendNotification", () => {
  const person = markReachable({ id: parsePersonId(IZA), workspaceId: parseWorkspaceId(WS), displayName: "Iza", userId: null, notifyChannels: ["slack"] });

  it("gives one result per channel and lets one channel fail without stopping another", async () => {
    const down: NotifyChannel = { id: "slack", canReach: async () => false, send: async () => ({ channel: "slack", status: "sent" }) };
    const up: NotifyChannel = { id: "email" as NotifyChannelId, canReach: async () => true, send: async () => ({ channel: "email" as NotifyChannelId, status: "sent" }) };
    const result = await sendNotification({ slack: down, email: up } as Record<NotifyChannelId, NotifyChannel>, person, { text: "hi" }, ["slack", "email" as NotifyChannelId]);
    expect(result.results as unknown).toEqual([{ channel: "slack", status: "failed", code: "not_reachable" }, { channel: "email", status: "sent" }]);
  });

  it("reports provider_error when a channel throws", async () => {
    const broken: NotifyChannel = { id: "slack", canReach: async () => { throw new Error("boom"); }, send: async () => ({ channel: "slack", status: "sent" }) };
    expect((await sendNotification({ slack: broken } as Record<NotifyChannelId, NotifyChannel>, person, { text: "hi" })).results).toEqual([{ channel: "slack", status: "failed", code: "provider_error" }]);
  });
});

describe("the Slack channel", () => {
  const person = markReachable({ id: parsePersonId(IZA), workspaceId: parseWorkspaceId(WS), displayName: "Iza", userId: null, notifyChannels: ["slack"] });
  const seed = (identityStatus: string, connectionStatus = "active") => {
    const db = newDb();
    db.tables.person_identities!.push({ id: "i1", workspace_id: WS, person_id: IZA, provider: "slack", external_id: "U42", status: identityStatus });
    db.tables.connections!.push({ id: "c1", workspace_id: WS, provider: "slack", status: connectionStatus, credential_id: "cred-1" });
    return db;
  };
  const deps = () => ({ resolveBotToken: mock(async () => "xoxb-test"), openDm: mock(async () => "D123"), postMessage: mock(async () => {}) });

  it("ends the Slack message with the attribution after a blank line", () => {
    expect(renderSlackText({ text: "hello", link: "https://x.dev", attribution: "Sent by Uzo through Draft" })).toBe("hello\nhttps://x.dev\n\nSent by Uzo through Draft");
    expect(renderSlackText({ text: "hello" })).toBe("hello");
  });

  it("opens a DM with the person's Slack id and posts the text with its link", async () => {
    const d = deps();
    const channel = slackChannel(fakeClient(seed("from_connection")), d);
    expect(await channel.canReach(person)).toBe(true);
    expect(await channel.send(person, { text: "hello", link: "https://app.example/x" })).toEqual({ channel: "slack", status: "sent" });
    expect(d.openDm).toHaveBeenCalledWith("xoxb-test", "U42");
    expect(d.postMessage).toHaveBeenCalledWith("xoxb-test", "D123", "hello\nhttps://app.example/x");
  });

  it("cannot reach a person whose Slack id is only a guess, or a workspace with Slack disconnected", async () => {
    expect(await slackChannel(fakeClient(seed("inferred")), deps()).canReach(person)).toBe(false);
    expect(await slackChannel(fakeClient(seed("confirmed", "revoked")), deps()).canReach(person)).toBe(false);
    expect(await slackChannel(fakeClient(newDb()), deps()).send(person, { text: "x" })).toEqual({ channel: "slack", status: "failed", code: "not_reachable" });
  });

  it("throws when Slack refuses, so the sender can log it and report provider_error", async () => {
    const d = deps();
    d.postMessage = mock(async () => { throw new Error("channel_not_found"); });
    const channel = slackChannel(fakeClient(seed("confirmed")), d);
    await expect(channel.send(person, { text: "x" })).rejects.toThrow("channel_not_found");
    const logged: unknown[] = [];
    const result = await sendNotification({ slack: channel } as Record<NotifyChannelId, NotifyChannel>, person, { text: "x" }, ["slack"], (_id, error) => { logged.push(error); });
    expect(result.results).toEqual([{ channel: "slack", status: "failed", code: "provider_error" }]);
    expect(logged).toHaveLength(1);
  });
});

describe("telling admins about a pending person", () => {
  const evidence = { quote: "Cory joined the standup as our new intern.", sourceItemId: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
  const create = (call: ReturnType<typeof setup>["call"], caller: ToolCaller = asRun([{ tool: "people.find" }, { tool: "people.create" }])) =>
    call(caller, "people.create", { displayName: "Cory Banks", evidence });

  it("sends each reachable admin the agent line, the quote, and how to approve", async () => {
    const { call, sent, db } = setup();
    db.tables.source_items!.push({ id: evidence.sourceItemId, workspace_id: WS, visibility: "shared", metadata_json: { title: "Nov 9 standup" } });
    const result = await create(call);
    expect(result).toMatchObject({ status: "ok", output: { created: true, person: { status: "pending" } } });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.personId).toBe(ADA);
    const text = sent[0]!.message.text!;
    expect(text.startsWith('Draft found Cory Banks in "Nov 9 standup"')).toBe(true);
    expect(sent[0]!.message.attribution).toBe(LINE);
    expect(text).toContain(evidence.quote);
    expect(text).toContain("draft people approve ");
    expect(text).toContain('approve Cory Banks in Draft');
  });

  it("does not name a private source to the admins", async () => {
    const { call, sent, db } = setup();
    db.tables.source_items!.push({ id: evidence.sourceItemId, workspace_id: WS, visibility: "private", metadata_json: { title: "Secret 1:1" } });
    await create(call);
    expect(sent[0]!.message.text).not.toContain("Secret 1:1");
    expect(sent[0]!.message.text).toContain("in a source");
  });

  it("still creates the person when the message fails", async () => {
    const channel: NotifyChannel = { id: "slack", canReach: async () => true, send: async () => { throw new Error("slack is down"); } };
    const { call, db } = setup({ channel });
    expect(await create(call)).toMatchObject({ status: "ok", output: { created: true } });
    expect(db.tables.people!.some((p) => p.display_name === "Cory Banks")).toBe(true);
  });

  it("sends nothing for an admin's own addition, which is already active", async () => {
    const { call, sent } = setup();
    expect(await create(call, asUser(ADMIN))).toMatchObject({ output: { created: true, person: { status: "active" } } });
    expect(sent).toHaveLength(0);
  });

  it("sends nothing when the person already exists", async () => {
    const { call, sent } = setup();
    await call(asRun([{ tool: "people.find" }, { tool: "people.create" }]), "people.create", { displayName: "Uzo", evidence });
    expect(sent).toHaveLength(0);
  });
});


it("lets synthesis notify active teammates without a human owner or the routine fallback cap", async () => {
  const { call, db, sent } = setup();
  for (let i = 0; i < 100; i++) db.tables.agent_run_tool_calls!.push({ agent_run_id: RUN, tool_name: "people.notify", status: "ok" });
  const caller = runCaller({ ...runSpec(SYNTHESIS_PERMISSIONS, null), kind: "synthesis" });
  expect(await call(caller, "people.notify", { personId: IZA, text: "Synthetic test message." })).toMatchObject({ status: "ok" });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.message.text).toContain("synthesis run");
});
