import { describe, expect, it } from "bun:test";
import { GoogleOAuthError, refreshGoogleAccessToken } from "../../ingestion/google/oauth";
import { describeGoogleError, googleRequest } from "../../ingestion/google/request";

const rateLimit = (reason = "rateLimitExceeded") =>
  new Response(JSON.stringify({ error: { code: 403, message: "User-rate limit exceeded.", errors: [{ reason }] } }), { status: 403 });

function sequence(responses: Array<() => Response>) {
  const calls: number[] = [];
  const send = async () => {
    calls.push(calls.length);
    return (responses[calls.length - 1] ?? responses[responses.length - 1]!)();
  };
  return { send, calls };
}

const instant = { sleep: async () => {}, random: () => 0 };

describe("googleRequest", () => {
  it("retries a rate-limit 403 and returns the later success", async () => {
    const { send, calls } = sequence([() => rateLimit(), () => rateLimit("userRateLimitExceeded"), () => new Response("{}")]);
    const result = await googleRequest(send, instant);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("backs off between attempts and honors Retry-After", async () => {
    const waits: number[] = [];
    const { send } = sequence([
      () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }),
      () => new Response("{}", { status: 503 }),
      () => new Response("{}"),
    ]);
    await googleRequest(send, { sleep: async (ms) => void waits.push(ms), random: () => 0 });
    expect(waits).toEqual([2000, 1000]);
  });

  it("does not retry a permission failure and reports Google's reason", async () => {
    const { send, calls } = sequence([() => rateLimit("insufficientPermissions")]);
    const result = await googleRequest(send, instant);
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.info).toMatchObject({ status: 403, reason: "insufficientPermissions", message: "User-rate limit exceeded." });
  });

  it("gives up after the retry budget and says how many attempts it made", async () => {
    const { send, calls } = sequence([() => rateLimit()]);
    const result = await googleRequest(send, { ...instant, maxRetries: 2 });
    expect(calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = describeGoogleError("Gmail", result.info, result.attempts);
      expect(message).toBe("Gmail request failed with status 403 (rateLimitExceeded): User-rate limit exceeded. after 3 attempts");
    }
  });
});

describe("Google token refresh keeps the failure reason in the error message", () => {
  const fetchOf = (...responses: Array<() => Response>) => {
    const { send } = sequence(responses);
    return (async () => send()) as unknown as typeof fetch;
  };

  it("token refresh keeps invalid_grant as the code and puts the description in the message", async () => {
    const body = JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." });
    const fetchImpl = (async () => new Response(body, { status: 400 })) as unknown as typeof fetch;
    const error = (await refreshGoogleAccessToken({ clientId: "c", clientSecret: "s", redirectUri: "r" }, "r", fetchImpl, instant).catch((e) => e)) as GoogleOAuthError;
    expect(error.code).toBe("invalid_grant");
    expect(error.message).toContain("Token has been expired or revoked.");
  });

  it("token refresh retries a transient 503", async () => {
    const tokens = JSON.stringify({ access_token: "a", expires_in: 3600 });
    const fetchImpl = fetchOf(() => new Response("{}", { status: 503 }), () => new Response(tokens));
    const result = await refreshGoogleAccessToken({ clientId: "c", clientSecret: "s", redirectUri: "r" }, "r", fetchImpl, instant);
    expect(result.accessToken).toBe("a");
  });
});
