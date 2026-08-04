import { describe, expect, it } from "bun:test";
import {
  authenticateSandboxCallbackRequest,
  SandboxCallbackRequestError,
} from "../../sandbox/callback-request";
import { createSandboxCallbackToken } from "../../sandbox/callback-token";

const secret = "super-sensitive-callback-secret";
const runId = "run-123";
const bundleHash = "a".repeat(64);
const now = 1_000;
const claims = { runId, bundleHash, expiresAt: 2_000, nonce: "nonce-1" };

function callbackRequest(overrides: {
  token?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
} = {}): Request {
  const body = overrides.body ?? JSON.stringify({ run_id: runId, bundle_hash: bundleHash, result: { ok: true } });
  const token = overrides.token ?? createSandboxCallbackToken(claims, secret);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json; charset=utf-8",
    "idempotency-key": `draft:${runId}:${bundleHash}`,
    "x-draft-run-id": runId,
    "x-draft-bundle-hash": bundleHash,
  };
  for (const [name, value] of Object.entries(overrides.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Request("http://internal.test/callback", {
    method: overrides.method ?? "POST",
    headers,
    body: overrides.method === "GET" ? undefined : body,
  });
}

async function errorMessage(request: Request, requestSecret = secret): Promise<string> {
  try {
    await authenticateSandboxCallbackRequest(request, requestSecret, { now });
    throw new Error("expected authentication to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxCallbackRequestError);
    return (error as Error).message;
  }
}

describe("sandbox callback request authentication", () => {
  it("returns the authenticated envelope for a valid HTTP or HTTPS-independent request", async () => {
    await expect(authenticateSandboxCallbackRequest(callbackRequest(), secret, { now })).resolves.toEqual({
      runId,
      bundleHash,
      result: { ok: true },
      claims,
    });
  });

  it("rejects tampered and expired callback tokens", async () => {
    const token = createSandboxCallbackToken(claims, secret);
    const [payload, signature] = token.split(".");
    const tampered = `${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    await expect(authenticateSandboxCallbackRequest(callbackRequest({ token: tampered }), secret, { now })).rejects.toThrow(
      "Callback authentication failed",
    );
    await expect(authenticateSandboxCallbackRequest(callbackRequest(), secret, { now: claims.expiresAt })).rejects.toThrow(
      "Callback authentication failed",
    );
  });

  it.each([
    ["run header", { "x-draft-run-id": "other" }],
    ["bundle header", { "x-draft-bundle-hash": "b".repeat(64) }],
    ["idempotency key", { "idempotency-key": `draft:other:${bundleHash}` }],
  ])("rejects a mismatched %s", async (_label, headers) => {
    await expect(authenticateSandboxCallbackRequest(callbackRequest({ headers }), secret, { now })).rejects.toThrow(
      "Callback identifiers do not match",
    );
  });

  it("rejects mismatched body identifiers", async () => {
    const bodies = [
      { run_id: "other", bundle_hash: bundleHash, result: null },
      { run_id: runId, bundle_hash: "b".repeat(64), result: null },
    ];
    for (const body of bodies) {
      await expect(
        authenticateSandboxCallbackRequest(callbackRequest({ body: JSON.stringify(body) }), secret, { now }),
      ).rejects.toThrow("Callback identifiers do not match");
    }
  });

  it("rejects missing or malformed required headers", async () => {
    const cases: Array<Record<string, string | undefined>> = [
      { authorization: undefined },
      { authorization: "Basic abc" },
      { "content-type": undefined },
      { "content-type": "text/plain" },
      { "x-draft-run-id": undefined },
      { "x-draft-bundle-hash": undefined },
      { "idempotency-key": undefined },
    ];
    for (const headers of cases) {
      await expect(authenticateSandboxCallbackRequest(callbackRequest({ headers }), secret, { now })).rejects.toBeInstanceOf(
        SandboxCallbackRequestError,
      );
    }
  });

  it("requires POST and a valid exact callback body shape", async () => {
    await expect(authenticateSandboxCallbackRequest(callbackRequest({ method: "GET" }), secret, { now })).rejects.toThrow(
      "Callback method must be POST",
    );
    const invalidBodies = [
      "not json",
      "null",
      JSON.stringify({ run_id: runId, bundle_hash: bundleHash }),
      JSON.stringify({ run_id: runId, bundle_hash: bundleHash, result: null, extra: true }),
      `{"run_id":"${runId}","run_id":"${runId}","bundle_hash":"${bundleHash}","result":null}`,
    ];
    for (const body of invalidBodies) {
      await expect(authenticateSandboxCallbackRequest(callbackRequest({ body }), secret, { now })).rejects.toBeInstanceOf(
        SandboxCallbackRequestError,
      );
    }
  });

  it("enforces declared and actual body byte limits", async () => {
    const body = JSON.stringify({ run_id: runId, bundle_hash: bundleHash, result: "large" });
    await expect(
      authenticateSandboxCallbackRequest(callbackRequest({ body }), secret, { now, maxBodyBytes: body.length - 1 }),
    ).rejects.toThrow("Callback body is too large");

    await expect(
      authenticateSandboxCallbackRequest(
        callbackRequest({ body, headers: { "content-length": String(body.length + 1) } }),
        secret,
        { now },
      ),
    ).rejects.toThrow("Content-Length does not match body");

    await expect(
      authenticateSandboxCallbackRequest(
        callbackRequest({ body, headers: { "content-length": "999999" } }),
        secret,
        { now, maxBodyBytes: 100 },
      ),
    ).rejects.toThrow("Callback body is too large");
  });

  it("never leaks token, secret, or result content in errors", async () => {
    const resultMarker = "private-result-marker";
    const token = createSandboxCallbackToken(claims, secret);
    const message = await errorMessage(
      callbackRequest({
        token,
        headers: { "x-draft-run-id": "wrong" },
        body: JSON.stringify({ run_id: runId, bundle_hash: bundleHash, result: resultMarker }),
      }),
      "wrong-secret-marker",
    );
    expect(message).not.toContain(token);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("wrong-secret-marker");
    expect(message).not.toContain(resultMarker);
  });
});
