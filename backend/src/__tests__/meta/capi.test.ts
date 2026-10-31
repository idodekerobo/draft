import { describe, expect, it } from "bun:test";
import { buildMetaRequest, MetaSendError, sendMetaEvent, type MetaEventInput } from "../../meta/capi";
import { hashForMeta } from "../../meta/hash";
import { readMetaSettings } from "../../meta/settings";

const settings = { pixelId: "123", accessToken: "secret-value", testEventCode: "TEST1" };
const event: MetaEventInput = {
  eventName: "Lead",
  eventId: "evt-1",
  email: "  Person@Example.com ",
  externalId: "signup-1",
  sourceUrl: "https://draftai.us/getstarted",
  fbp: "fb.1.1.2",
  clientIp: "203.0.113.5",
  userAgent: "Mozilla/5.0",
  contentName: "getstarted",
};

describe("hashForMeta", () => {
  it("trims and lowercases before hashing", () => {
    expect(hashForMeta("  Person@Example.com ")).toBe(hashForMeta("person@example.com"));
    expect(hashForMeta("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  });
});

describe("readMetaSettings", () => {
  it("is off without a pixel id or access token", () => {
    expect(readMetaSettings({})).toBeNull();
    expect(readMetaSettings({ META_PIXEL_ID: "1" })).toBeNull();
  });

  it("requires a test event code unless live", () => {
    const base = { META_PIXEL_ID: "1", META_CAPI_ACCESS_TOKEN: "t" };
    expect(readMetaSettings(base)).toBeNull();
    expect(readMetaSettings({ ...base, META_CAPI_TEST_EVENT_CODE: "TEST9" })).toEqual({
      pixelId: "1",
      accessToken: "t",
      testEventCode: "TEST9",
    });
    expect(readMetaSettings({ ...base, META_CAPI_LIVE: "true" })).toEqual({ pixelId: "1", accessToken: "t" });
  });
});

describe("buildMetaRequest", () => {
  it("hashes identifiers and keeps the token out of the url", () => {
    const { url, body } = buildMetaRequest(event, settings, 1_700_000_000_000);
    expect(url).toContain("/123/events");
    expect(url).not.toContain("secret-value");
    expect(body.access_token).toBe("secret-value");
    expect(body.test_event_code).toBe("TEST1");
    const data = body.data[0] as Record<string, any>;
    expect(data.event_name).toBe("Lead");
    expect(data.event_time).toBe(1_700_000_000);
    expect(data.event_id).toBe("evt-1");
    expect(data.action_source).toBe("website");
    expect(data.event_source_url).toBe("https://draftai.us/getstarted");
    expect(data.user_data.em).toEqual([hashForMeta("person@example.com")]);
    expect(data.user_data.external_id).toEqual([hashForMeta("signup-1")]);
    expect(data.user_data.fbp).toBe("fb.1.1.2");
    expect(data.user_data.fbc).toBeUndefined();
    expect(data.user_data.client_ip_address).toBe("203.0.113.5");
    expect(data.custom_data).toEqual({ content_name: "getstarted" });
  });

  it("hashes names when present and omits the test code when unset", () => {
    const { body } = buildMetaRequest({ ...event, firstName: "Sam", lastName: "Lee" }, { pixelId: "1", accessToken: "t" });
    expect(body.test_event_code).toBeUndefined();
    const data = body.data[0] as Record<string, any>;
    expect(data.user_data.fn).toEqual([hashForMeta("sam")]);
    expect(data.user_data.ln).toEqual([hashForMeta("lee")]);
  });
});

describe("sendMetaEvent", () => {
  it("posts json to the graph api", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await sendMetaEvent(event, settings, fakeFetch);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("POST");
  });

  it("throws with the status and meta error code on a rejected request", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 })) as unknown as typeof fetch;
    const error = await sendMetaEvent(event, settings, fakeFetch).catch((caught) => caught);
    expect(error).toBeInstanceOf(MetaSendError);
    expect(error.status).toBe(400);
    expect(error.metaCode).toBe(190);
  });

  it("wraps network failures without leaking the request body", async () => {
    const fakeFetch = (async () => {
      throw new Error("connect failed secret-value");
    }) as unknown as typeof fetch;
    const error = await sendMetaEvent(event, settings, fakeFetch).catch((caught) => caught);
    expect(error).toBeInstanceOf(MetaSendError);
    expect(error.status).toBeNull();
    expect(error.message).not.toContain("secret-value");
  });
});
