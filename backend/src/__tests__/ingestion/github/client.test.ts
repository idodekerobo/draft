import { beforeAll, describe, expect, it } from "bun:test";
import { exportPKCS8, generateKeyPair, decodeJwt, decodeProtectedHeader } from "jose";
import { GithubClient, GithubClientError } from "../../../ingestion/github/client";

let privateKeyPem: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
});

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  let calls = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    calls++;
    return handler(url, init);
  }) as typeof fetch;
  return { fn, callCount: () => calls };
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("GithubClient JWT claims", () => {
  it("signs a JWT with iss=appId, iat 60s in the past, exp <=10min after iat", async () => {
    let capturedAuth: string | undefined;
    const { fn } = fakeFetch((url, init) => {
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      return jsonResponse(200, {
        token: "installation-token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    });
    const nowMs = Date.now();
    const client = new GithubClient({ appId: "999", privateKeyPem, fetch: fn, now: () => nowMs });
    await client.getInstallationToken("install-1");

    const jwt = capturedAuth!.replace("Bearer ", "");
    const header = decodeProtectedHeader(jwt);
    const claims = decodeJwt(jwt);
    expect(header.alg).toBe("RS256");
    expect(claims.iss).toBe("999");
    const nowSeconds = Math.floor(nowMs / 1000);
    expect(claims.iat).toBe(nowSeconds - 60);
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(600);
  });
});

describe("GithubClient token cache", () => {
  it("reuses a cached token until near expiry, then re-mints", async () => {
    let nowMs = Date.now();
    const { fn, callCount } = fakeFetch(() =>
      jsonResponse(200, { token: "tok", expires_at: new Date(nowMs + 3600_000).toISOString() }),
    );
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn, now: () => nowMs });

    await client.getInstallationToken("install-1");
    await client.getInstallationToken("install-1");
    expect(callCount()).toBe(1);

    nowMs += 3600_000 - 60_000; // inside the 5-min refresh margin
    await client.getInstallationToken("install-1");
    expect(callCount()).toBe(2);
  });

  it("dedupes concurrent requests for the same installation into one mint", async () => {
    const { fn, callCount } = fakeFetch(() =>
      jsonResponse(200, { token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    );
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });

    await Promise.all([
      client.getInstallationToken("install-1"),
      client.getInstallationToken("install-1"),
      client.getInstallationToken("install-1"),
    ]);
    expect(callCount()).toBe(1);
  });

  it("mints independently per installation", async () => {
    const { fn, callCount } = fakeFetch(() =>
      jsonResponse(200, { token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    );
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });

    await Promise.all([
      client.getInstallationToken("install-1"),
      client.getInstallationToken("install-2"),
    ]);
    expect(callCount()).toBe(2);
  });
});

describe("GithubClient response classification", () => {
  it("retries once on 401 then succeeds", async () => {
    let call = 0;
    const { fn, callCount } = fakeFetch(() => {
      call++;
      if (call === 1) return jsonResponse(401, { message: "bad jwt" });
      return jsonResponse(200, { token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    });
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });
    const token = await client.getInstallationToken("install-1");
    expect(token).toBe("tok");
    expect(callCount()).toBe(2);
  });

  it("classifies 403 as permission with no retry", async () => {
    const { fn, callCount } = fakeFetch(() => jsonResponse(403, { message: "forbidden" }));
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });
    await expect(client.getInstallationToken("install-1")).rejects.toMatchObject({ kind: "permission" });
    expect(callCount()).toBe(1);
  });

  it("classifies 404 as gone with no retry", async () => {
    const { fn, callCount } = fakeFetch(() => jsonResponse(404, { message: "not found" }));
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });
    await expect(client.getInstallationToken("install-1")).rejects.toMatchObject({ kind: "gone" });
    expect(callCount()).toBe(1);
  });

  it("classifies 429 as rate_limited, surfacing Retry-After, with no retry", async () => {
    const { fn, callCount } = fakeFetch(() => jsonResponse(429, { message: "rate limited" }, { "retry-after": "30" }));
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });
    let error: GithubClientError | undefined;
    try {
      await client.getInstallationToken("install-1");
    } catch (err) {
      error = err as GithubClientError;
    }
    expect(error?.kind).toBe("rate_limited");
    expect(error?.retryAfterSeconds).toBe(30);
    expect(callCount()).toBe(1);
  });
});

describe("GithubClient.verifyInstallation", () => {
  it("returns account info on success", async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse(200, { account: { login: "acme", id: 42 }, suspended_at: null }),
    );
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });
    const info = await client.verifyInstallation("install-1");
    expect(info).toEqual({ accountLogin: "acme", accountId: 42, suspendedAt: null });
  });

  it("classifies a spoofed/nonexistent installation id as gone", async () => {
    const { fn } = fakeFetch(() => jsonResponse(404, { message: "not found" }));
    const client = new GithubClient({ appId: "1", privateKeyPem, fetch: fn });
    await expect(client.verifyInstallation("bogus")).rejects.toMatchObject({ kind: "gone" });
  });
});
