import { createHmac, timingSafeEqual } from "node:crypto";
import { readBoundedBody } from "../shared/read-bounded-body";

export const CAL_WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

export class CalWebhookAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalWebhookAuthError";
  }
}

function reject(message: string): never {
  throw new CalWebhookAuthError(message);
}

function verifySignature(header: string | null, secret: string, bodyBytes: Uint8Array): void {
  if (!header) reject("Cal webhook signature header is missing");
  const supplied = Buffer.from(header.replace(/^sha256=/, ""), "hex");
  if (supplied.length === 0) reject("Cal webhook signature header is malformed");

  const expected = createHmac("sha256", secret).update(bodyBytes).digest();
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    reject("Cal webhook signature is invalid");
  }
}

// Verifies the signature over the raw bytes before parsing, then returns the parsed JSON body.
export async function authenticateCalWebhookRequest(
  request: Request,
  options: { secret?: string; maxBodyBytes?: number } = {},
): Promise<unknown> {
  const secret = options.secret ?? process.env.CAL_WEBHOOK_SECRET;
  if (!secret) reject("Cal webhook secret is not configured");

  const bodyBytes = await readBoundedBody(
    request,
    options.maxBodyBytes ?? CAL_WEBHOOK_BODY_LIMIT_BYTES,
    () => reject("Cal webhook body is too large"),
  );
  verifySignature(request.headers.get("x-cal-signature-256"), secret, bodyBytes);

  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return reject("Cal webhook body is not valid JSON");
  }
}
