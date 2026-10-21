import { createHmac, timingSafeEqual } from "node:crypto";

interface WaitlistTokenClaims {
  signupId: string;
  exp: number;
}

function signature(payload: string): Buffer {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not configured");
  return createHmac("sha256", secret).update(payload).digest();
}

export function createWaitlistToken(signupId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ signupId, exp: now + 30 * 24 * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyWaitlistToken(token: unknown, now = Date.now()): WaitlistTokenClaims {
  if (typeof token !== "string") throw new Error("Waitlist token is missing");
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra !== undefined) throw new Error("Waitlist token is malformed");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  const expected = signature(payload);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Waitlist token signature is invalid");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Waitlist token claims are invalid");
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw new Error("Waitlist token claims are invalid");
  const record = claims as Record<string, unknown>;
  if (typeof record.signupId !== "string" || !record.signupId || typeof record.exp !== "number" || !Number.isSafeInteger(record.exp)) {
    throw new Error("Waitlist token claims are invalid");
  }
  if (now >= record.exp) throw new Error("Waitlist token has expired");
  return { signupId: record.signupId, exp: record.exp };
}
