import { describe, expect, it } from "bun:test";
import { parsePersonId, parseWorkspaceId } from "draft-core/run-spec";
import type { NotifyChannelId } from "draft-core/notify";
import { emailChannel } from "../../notify/channels/email/send";
import { sendNotification } from "../../notify/delivery/send";
import { markReachable, type NotifyChannel } from "../../notify/delivery/types";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const IZA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const person = markReachable({ id: parsePersonId(IZA), workspaceId: parseWorkspaceId(WS), displayName: "Iza", userId: null, notifyChannels: ["email"] });

const seed = (status: string | null) =>
  fakeClient(fakeDb({ person_identities: status ? [{ id: "i1", workspace_id: WS, person_id: IZA, provider: "email", external_id: "iza@example.com", status }] : [] }));

function setup(status: string | null = "confirmed", key: string | null = "re_key", response: Response | Error = new Response(JSON.stringify({ id: "em_1" }))) {
  const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    if (response instanceof Error) throw response;
    return response.clone();
  }) as unknown as typeof fetch;
  return { channel: emailChannel(seed(status), { apiKey: () => key ?? undefined, fetchFn, sleep: async () => {} }), calls };
}

describe("the email channel", () => {
  it("emails the verified address from the Draft sender with a prefixed subject", async () => {
    const { channel, calls } = setup();
    expect(await channel.send(person, { text: "Your research is ready", subject: "Research" })).toMatchObject({ channel: "email", status: "sent" });
    expect(calls[0]!.body).toMatchObject({ from: "Draft <notifications@notify.draftai.us>", to: ["iza@example.com"], subject: "Draft: Research", text: "Your research is ready" });
  });

  it("appends the link to the text", async () => {
    const { channel, calls } = setup();
    await channel.send(person, { text: "See this", link: "https://x.dev/a" });
    expect(calls[0]!.body.text).toBe("See this\nhttps://x.dev/a");
  });

  it("ends the email with the attribution line", async () => {
    const { channel, calls } = setup();
    await channel.send(person, { text: "Your research is ready", attribution: "🤖 Draft agent · routine run" });
    expect(calls[0]!.body.text).toBe("Your research is ready\n\n🤖 Draft agent · routine run");
    expect(String(calls[0]!.body.html).endsWith("🤖 Draft agent · routine run</p>")).toBe(true);
  });

  it("accepts html alone and makes the text", async () => {
    const { channel, calls } = setup();
    await channel.send(person, { html: "<p>Hello</p>" });
    expect(calls[0]!.body).toMatchObject({ text: "Hello", html: "<p>Hello</p>" });
  });

  it("cannot reach a person with no verified email, or when no key is set", async () => {
    expect(await setup(null).channel.canReach(person)).toBe(false);
    expect(await setup("guess").channel.canReach(person)).toBe(false);
    expect(await setup("confirmed", null).channel.canReach(person)).toBe(false);
    expect(await setup("from_connection").channel.canReach(person)).toBe(true);
    expect(await setup(null).channel.send(person, { text: "x" })).toEqual({ channel: "email", status: "failed", code: "not_reachable" });
  });

  it("uses the delivery id as the provider idempotency key, on every attempt, and returns the provider id", async () => {
    const { channel, calls } = setup();
    expect(await channel.send(person, { text: "a" }, { deliveryId: "delivery-1" })).toEqual({ channel: "email", status: "sent", providerMessageId: "em_1" });
    await channel.send(person, { text: "a" }, { deliveryId: "delivery-1" });
    await channel.send(person, { text: "a" });
    await channel.send(person, { text: "a" });
    const keys = calls.map((call) => call.headers["Idempotency-Key"]);
    expect(keys.slice(0, 2)).toEqual(["delivery-1", "delivery-1"]);
    expect(keys[2]).not.toBe(keys[3]);
  });

  it("throws on a provider error so sendNotification logs it and reports provider_error", async () => {
    const { channel } = setup("confirmed", "re_key", new Response(JSON.stringify({ name: "validation_error" }), { status: 422 }));
    const logged: unknown[] = [];
    const result = await sendNotification({ email: channel } as Record<NotifyChannelId, NotifyChannel>, person, { text: "x" }, ["email"], (_id, error) => { logged.push(error); });
    expect(result.results).toEqual([{ channel: "email", status: "failed", code: "provider_error" }]);
    expect(logged[0]).toMatchObject({ name: "ResendError", statusCode: 422 });
  });

  it("keeps acceptance uncertain after bounded network retries", async () => {
    const { channel, calls } = setup("confirmed", "re_key", new Error("timeout"));
    const result = await sendNotification({ email: channel } as Record<NotifyChannelId, NotifyChannel>, person, { text: "x" }, ["email"]);
    expect(result.results).toEqual([{ channel: "email", status: "queued" }]);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.headers["Idempotency-Key"])).size).toBe(1);
  });

  it("throws for a message with no body", async () => {
    await expect(setup().channel.send(person, { subject: "only a subject" })).rejects.toThrow("email_content_invalid: empty_body");
  });
});
