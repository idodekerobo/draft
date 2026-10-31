import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { authenticateCalWebhookRequest, CalWebhookAuthError } from "../../../webhooks/cal/request-auth";

const secret = "test-secret";

function sign(body: string, key = secret) {
  return createHmac("sha256", key).update(body).digest("hex");
}

function request(body: string, signature: string | null) {
  return new Request("http://localhost/webhooks/cal", {
    method: "POST",
    headers: signature === null ? {} : { "x-cal-signature-256": signature },
    body,
  });
}

describe("authenticateCalWebhookRequest", () => {
  it("returns the parsed body for a valid signature", async () => {
    const body = JSON.stringify({ triggerEvent: "PING" });
    expect(await authenticateCalWebhookRequest(request(body, sign(body)), { secret })).toEqual({ triggerEvent: "PING" });
  });

  it("accepts a sha256= prefix", async () => {
    const body = JSON.stringify({ a: 1 });
    expect(await authenticateCalWebhookRequest(request(body, `sha256=${sign(body)}`), { secret })).toEqual({ a: 1 });
  });

  it("rejects a signature made with another secret", async () => {
    const body = JSON.stringify({ a: 1 });
    await expect(authenticateCalWebhookRequest(request(body, sign(body, "other")), { secret })).rejects.toBeInstanceOf(
      CalWebhookAuthError,
    );
  });

  it("rejects a body that changed after signing", async () => {
    const signature = sign(JSON.stringify({ a: 1 }));
    await expect(authenticateCalWebhookRequest(request(JSON.stringify({ a: 2 }), signature), { secret })).rejects.toBeInstanceOf(
      CalWebhookAuthError,
    );
  });

  it("rejects a missing or malformed header", async () => {
    const body = JSON.stringify({ a: 1 });
    await expect(authenticateCalWebhookRequest(request(body, null), { secret })).rejects.toBeInstanceOf(CalWebhookAuthError);
    await expect(authenticateCalWebhookRequest(request(body, "zz"), { secret })).rejects.toBeInstanceOf(CalWebhookAuthError);
  });

  it("rejects everything when no secret is configured", async () => {
    const body = JSON.stringify({ a: 1 });
    await expect(authenticateCalWebhookRequest(request(body, sign(body)), { secret: "" })).rejects.toBeInstanceOf(
      CalWebhookAuthError,
    );
  });

  it("rejects a signed body that is not json", async () => {
    const body = "not json";
    await expect(authenticateCalWebhookRequest(request(body, sign(body)), { secret })).rejects.toBeInstanceOf(CalWebhookAuthError);
  });

  it("rejects a body over the limit", async () => {
    const body = JSON.stringify({ a: "x".repeat(100) });
    await expect(
      authenticateCalWebhookRequest(request(body, sign(body)), { secret, maxBodyBytes: 10 }),
    ).rejects.toBeInstanceOf(CalWebhookAuthError);
  });
});
