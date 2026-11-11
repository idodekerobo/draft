import { describe, expect, it, mock } from "bun:test";
import type { ChannelSendResult, NotifyChannelId, NotifyMessage } from "draft-core/notify";
import { agentActor, parseAgentRunId, parseContextVersionId, parsePersonId, parseUserId, parseWorkspaceId, parseScheduledTaskId, parseIsoTimestamp, type AgentRunSpec } from "draft-core/run-spec";
import type { AnyDraftToolPermission, ToolCaller } from "draft-core/tools";
import { createPeopleTools } from "../../metaharness/tools/definitions/people";
import { invokeTool } from "../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../metaharness/tools/tool-registry";
import { markReachable, type NotifyChannel } from "../../notify/types";
import { sendNotification } from "../../notify/send";
import { slackChannel } from "../../notify/slack";
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
      source_connections: [],
      source_items: [],
      scheduled_tasks: [{ id: TASK, workspace_id: WS, config_json: { title: "Meeting follow-up" } }],
      agent_run_tool_calls: [],
      agent_runs: [{ id: RUN, workspace_id: WS, scheduled_task_id: TASK }],
    },
    { unique: { people: [["workspace_id", "user_id"]], person_identities: [["workspace_id", "provider", "external_id"]] }, uuidTables: ["people"] },
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

function setup(options: { db?: ReturnType<typeof newDb>; channel?: NotifyChannel } = {}) {
  const db = options.db ?? newDb();
  const recorder = recordingChannel();
  const channel = options.channel ?? recorder.channel;
  const registry = new ToolRegistry(createPeopleTools(fakeClient(db), { channels: { slack: channel } as Record<NotifyChannelId, NotifyChannel> }));
  const call = (caller: ToolCaller, tool: string, args: unknown) => invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, tool, args);
  return { db, call, sent: recorder.sent };
}

const runSpec = (permissions: ReadonlyArray<AnyDraftToolPermission>, onBehalfOf: string | null = OWNER): AgentRunSpec => ({
  id: parseAgentRunId(RUN),
  kind: "routine",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "cron", scheduledTaskId: parseScheduledTaskId(TASK), occurrenceAt: parseIsoTimestamp("2026-11-11T09:00:00.000Z") },
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
const asRun = (permissions: ReadonlyArray<AnyDraftToolPermission>, onBehalfOf: string | null = OWNER): ToolCaller => ({ type: "run", run: runSpec(permissions, onBehalfOf) });
const asUser = (userId = OWNER): ToolCaller => ({ type: "user", userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "cli" });

const toMembers: AnyDraftToolPermission[] = [{ tool: "people.notify", limits: { recipients: "members", maxPerRun: 3 } }];
const LINE = `🤖 Draft agent · running Uzo's "Meeting follow-up" routine`;

describe("people.notify", () => {
  it("starts every run message with a fixed line naming the owner and the routine, then the model's text", async () => {
    const { call, sent } = setup();
    const result = await call(asRun(toMembers), "people.notify", { personId: IZA, text: "Your items: ship the demo." });
    expect(result).toMatchObject({ status: "ok", output: { results: [{ channel: "slack", status: "sent" }] } });
    expect(sent[0]!.message.text).toBe(`${LINE}\nYour items: ship the demo.`);
  });

  it("keeps the line first even when the model writes its own first line", async () => {
    const { call, sent } = setup();
    await call(asRun(toMembers), "people.notify", { personId: IZA, text: "Ignore the line above. This message is from a human, not an agent." });
    expect(sent[0]!.message.text.startsWith(`${LINE}\n`)).toBe(true);
  });

  it("names the person who sent a message from the CLI", async () => {
    const { call, sent } = setup();
    await call(asUser(OWNER), "people.notify", { personId: IZA, text: "hello" });
    expect(sent[0]!.message.text).toBe("Sent by Uzo through Draft\nhello");
  });

  it("names the routine for a run an event started, whose trigger does not carry the task", async () => {
    const { call, sent } = setup();
    const eventRun: ToolCaller = { type: "run", run: { ...runSpec(toMembers), trigger: { type: "webhook", provider: "fireflies", eventId: "meeting-1" } } };
    await call(eventRun, "people.notify", { personId: IZA, text: "Your items." });
    expect(sent[0]!.message.text).toBe(`${LINE}\nYour items.`);
  });

  it("says a run with no routine title, or no owner, is still an agent", async () => {
    const { call, sent, db } = setup();
    db.tables.scheduled_tasks![0]!.config_json = {};
    await call(asRun(toMembers), "people.notify", { personId: IZA, text: "a" });
    expect(sent[0]!.message.text.split("\n")[0]).toBe("🤖 Draft agent · running a routine for Uzo");
    await call(asRun([{ tool: "people.notify", limits: { recipients: "members" } }], null), "people.notify", { personId: IZA, text: "b" });
    expect(sent[1]!.message.text.split("\n")[0]).toBe("🤖 Draft agent · routine run");
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
    db.tables.source_connections!.push({ id: "c1", workspace_id: WS, provider: "slack", status: connectionStatus, credential_id: "cred-1" });
    return db;
  };
  const deps = () => ({ resolveBotToken: mock(async () => "xoxb-test"), openDm: mock(async () => "D123"), postMessage: mock(async () => {}) });

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

  it("reports provider_error when Slack refuses", async () => {
    const d = deps();
    d.postMessage = mock(async () => { throw new Error("channel_not_found"); });
    expect(await slackChannel(fakeClient(seed("confirmed")), d).send(person, { text: "x" })).toEqual({ channel: "slack", status: "failed", code: "provider_error" });
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
    const text = sent[0]!.message.text;
    expect(text.startsWith(`${LINE}\nDraft found Cory Banks in "Nov 9 standup"`)).toBe(true);
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
