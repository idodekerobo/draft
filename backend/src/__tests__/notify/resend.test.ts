import { describe, expect, it } from "bun:test";
import { getResendEmail, ResendError, sendResendEmail } from "../../notify/channels/email/resend";

const email = { from: "Draft <notifications@notify.draftai.us>", to: ["a@example.com"], subject: "Draft: Hi", text: "hi", html: "<p>hi</p>" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const noSleep = async () => {};

function fakeFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("sendResendEmail", () => {
  it("posts the email with the bearer key and idempotency key, and returns the id", async () => {
    const { fetchFn, calls } = fakeFetch(json({ id: "em_1" }));
    expect(await sendResendEmail("re_key", email, "idem-1", { fetchFn, sleep: noSleep })).toEqual({ id: "em_1" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_key");
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(email);
  });

  it("retries a timeout and a 5xx with the same idempotency key", async () => {
    const { fetchFn, calls } = fakeFetch(new Error("timeout"), json({ name: "internal_server_error" }, 500), json({ id: "em_2" }));
    expect(await sendResendEmail("k", email, "idem-2", { fetchFn, sleep: noSleep })).toEqual({ id: "em_2" });
    expect(calls.map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"])).toEqual(["idem-2", "idem-2", "idem-2"]);
  });

  it("gives up after three attempts", async () => {
    const { fetchFn, calls } = fakeFetch(json({}, 503), json({}, 503), json({}, 503));
    await expect(sendResendEmail("k", email, "i", { fetchFn, sleep: noSleep })).rejects.toMatchObject({ name: "ResendError", statusCode: 503 });
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 4xx, and carries Resend's error name", async () => {
    const { fetchFn, calls } = fakeFetch(json({ name: "invalid_idempotent_request" }, 409));
    const error = await sendResendEmail("k", email, "i", { fetchFn, sleep: noSleep }).catch((e) => e);
    expect(error).toBeInstanceOf(ResendError);
    expect(error).toMatchObject({ statusCode: 409, resendName: "invalid_idempotent_request", message: "resend_failed: invalid_idempotent_request" });
    expect(calls).toHaveLength(1);
  });

  it("never puts the API key in the error", async () => {
    const { fetchFn } = fakeFetch(json({ name: "restricted_api_key" }, 401));
    const error = await sendResendEmail("re_secret_key", email, "i", { fetchFn, sleep: noSleep }).catch((e) => e);
    expect(JSON.stringify({ message: error.message, name: error.name })).not.toContain("re_secret_key");
  });
});

describe("getResendEmail", () => {
  it("returns the latest event", async () => {
    const { fetchFn, calls } = fakeFetch(json({ id: "em_1", last_event: "delivered" }));
    expect(await getResendEmail("k", "em_1", { fetchFn })).toEqual({ id: "em_1", lastEvent: "delivered" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails/em_1");
  });
  it("throws a ResendError for a send-only key", async () => {
    const { fetchFn } = fakeFetch(json({ name: "restricted_api_key" }, 401));
    await expect(getResendEmail("k", "em_1", { fetchFn })).rejects.toMatchObject({ statusCode: 401, resendName: "restricted_api_key" });
  });
});
