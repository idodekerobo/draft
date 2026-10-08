import { serviceClient } from "../db/client";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_SOURCE_LENGTH = 80;
const MAX_ID_LENGTH = 200;
const MAX_ATTRIBUTION_VALUE_LENGTH = 500;
const MAX_PROFILE_VALUE_LENGTH = 1000;

const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ttclid",
  "fbclid",
  "landing_url",
  "referrer",
] as const;
const PROFILE_KEYS = ["how_heard", "use_case", "team_size"] as const;

interface WaitlistRequest {
  email?: unknown;
  source?: unknown;
  attribution?: unknown;
  posthog_distinct_id?: unknown;
}

interface WaitlistProfileRequest {
  email?: unknown;
  posthog_distinct_id?: unknown;
  profile?: unknown;
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, maxLength) || null;
}

function pickStrings(
  input: unknown,
  keys: readonly string[],
  maxLength: number,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof input !== "object" || input === null) return result;
  for (const key of keys) {
    const value = cleanString((input as Record<string, unknown>)[key], maxLength);
    if (value) result[key] = value;
  }
  return result;
}

// Accepts { first, last } touches; each is filtered to known keys.
function cleanAttribution(input: unknown): Record<string, Record<string, string>> | null {
  if (typeof input !== "object" || input === null) return null;
  const result: Record<string, Record<string, string>> = {};
  for (const touch of ["first", "last"] as const) {
    const picked = pickStrings(
      (input as Record<string, unknown>)[touch],
      ATTRIBUTION_KEYS,
      MAX_ATTRIBUTION_VALUE_LENGTH,
    );
    if (Object.keys(picked).length > 0) result[touch] = picked;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function cleanEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as WaitlistRequest | null;
  const email = cleanEmail(body?.email);
  const source = cleanString(body?.source, MAX_SOURCE_LENGTH) ?? "unknown";

  if (!email) {
    return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const { error } = await serviceClient
    .from("waitlist_signups")
    .upsert(
      {
        email,
        source,
        attribution: cleanAttribution(body?.attribution),
        posthog_distinct_id: cleanString(body?.posthog_distinct_id, MAX_ID_LENGTH),
      },
      { onConflict: "email", ignoreDuplicates: true },
    );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}

// The row must match both email and distinct id, so a stranger who knows an email cannot edit it.
export async function PROFILE_POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as WaitlistProfileRequest | null;
  const email = cleanEmail(body?.email);
  const distinctId = cleanString(body?.posthog_distinct_id, MAX_ID_LENGTH);
  const profile = pickStrings(body?.profile, PROFILE_KEYS, MAX_PROFILE_VALUE_LENGTH);

  if (!email || !distinctId) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  if (Object.keys(profile).length === 0) {
    return Response.json({ ok: true });
  }

  const { error } = await serviceClient
    .from("waitlist_signups")
    .update({ profile })
    .eq("email", email)
    .eq("posthog_distinct_id", distinctId);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
