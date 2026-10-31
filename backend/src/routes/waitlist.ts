import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { sendLeadEvent } from "../waitlist/events";
import { cleanProfile } from "../waitlist/profile";
import { isTrustedLandingRequest } from "../waitlist/trust";
import { createWaitlistToken, verifyWaitlistToken } from "./waitlist-token";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_SOURCE_LENGTH = 80;
const MAX_ID_LENGTH = 200;
const MAX_ATTRIBUTION_VALUE_LENGTH = 500;

const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ttclid",
  "fbclid",
  "fbp",
  "fbc",
  "gpc",
  "landing_url",
  "referrer",
] as const;

interface WaitlistRequest {
  email?: unknown;
  source?: unknown;
  attribution?: unknown;
  posthog_distinct_id?: unknown;
  event_id?: unknown;
  client?: unknown;
}

interface WaitlistProfileRequest {
  signup_token?: unknown;
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

// Browser details the landing page's server route forwards for Meta matching.
function cleanClient(input: unknown) {
  return pickStrings(input, ["ip", "user_agent", "source_url"], MAX_ATTRIBUTION_VALUE_LENGTH);
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

  const attribution = cleanAttribution(body?.attribution);
  // With ignoreDuplicates only a newly inserted row comes back, so a repeat signup is not a new lead.
  const { data: inserted, error } = await serviceClient
    .from("waitlist_signups")
    .upsert(
      {
        email,
        source,
        attribution,
        posthog_distinct_id: cleanString(body?.posthog_distinct_id, MAX_ID_LENGTH),
      },
      { onConflict: "email", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    await recordError({ workspaceId: null, allowUnattributed: true, operation: "read", message: "Waitlist signup save failed", error, detail: { email, source, attribution } });
    return Response.json({ error: error.message }, { status: 500 });
  }

  const { data: signup, error: lookupError } = await serviceClient
    .from("waitlist_signups")
    .select("id")
    .eq("email", email)
    .single();
  if (lookupError || !signup) {
    await recordError({ workspaceId: null, allowUnattributed: true, operation: "read", message: "Waitlist signup token lookup failed", error: lookupError, detail: { email, source } });
    return Response.json({ error: "Could not prepare waitlist signup" }, { status: 500 });
  }
  try {
    const signupToken = createWaitlistToken(signup.id);
    const eventId = cleanString(body?.event_id, MAX_ID_LENGTH);
    if (inserted?.length && eventId && isTrustedLandingRequest(request)) {
      const client = cleanClient(body?.client);
      void sendLeadEvent({
        signupId: signup.id,
        email,
        eventId,
        source,
        attribution,
        client: { ip: client.ip, userAgent: client.user_agent, sourceUrl: client.source_url },
      });
    }
    return Response.json({ ok: true, signup_token: signupToken });
  } catch (error) {
    await recordError({ workspaceId: null, allowUnattributed: true, operation: "auth", message: "Waitlist signup token creation failed", error, detail: { signup_id: signup.id, email, source } });
    return Response.json({ error: "Could not prepare waitlist signup" }, { status: 500 });
  }
}

// A signed signup token authorizes this update without relying on PostHog identity matching.
export async function PROFILE_POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as WaitlistProfileRequest | null;
  const profile = cleanProfile(body?.profile);
  if (Object.keys(profile).length === 0) {
    return Response.json({ ok: true });
  }

  let signupId: string;
  try {
    signupId = verifyWaitlistToken(body?.signup_token).signupId;
  } catch (error) {
    await recordError({
      workspaceId: null,
      allowUnattributed: true,
      operation: "auth",
      message: "Waitlist profile token validation failed",
      error,
      detail: { profile },
    });
    return Response.json({ error: "Could not save answers" }, { status: 401 });
  }

  const { data: existing, error: readError } = await serviceClient
    .from("waitlist_signups")
    .select("profile")
    .eq("id", signupId)
    .maybeSingle();
  if (readError) {
    await recordError({ workspaceId: null, allowUnattributed: true, operation: "read", message: "Waitlist profile read failed", error: readError, detail: { signup_id: signupId } });
    return Response.json({ error: readError.message }, { status: 500 });
  }
  if (!existing) {
    await recordError({ workspaceId: null, allowUnattributed: true, operation: "read", message: "Waitlist profile save matched no signup", detail: { signup_id: signupId, profile } });
    return Response.json({ error: "Waitlist signup could not be matched" }, { status: 404 });
  }

  const { error } = await serviceClient
    .from("waitlist_signups")
    .update({ profile: { ...(existing.profile ?? {}), ...profile } })
    .eq("id", signupId);
  if (error) {
    await recordError({ workspaceId: null, allowUnattributed: true, operation: "read", message: "Waitlist profile save failed", error, detail: { signup_id: signupId, profile } });
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
