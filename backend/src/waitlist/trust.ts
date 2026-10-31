import { timingSafeEqual } from "node:crypto";

export const LANDING_SECRET_HEADER = "x-draft-landing-secret";

// Only the landing page's server route knows the secret. Requests without it cannot trigger Meta events.
export function isTrustedLandingRequest(
  request: Request,
  secret: string | undefined = process.env.LANDING_PROXY_SECRET,
): boolean {
  const provided = request.headers.get(LANDING_SECRET_HEADER);
  if (!secret || !provided) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
