import { serviceClient } from "../db/client";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MAX_SOURCE_LENGTH = 80;

interface WaitlistRequest {
  email?: unknown;
  source?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as WaitlistRequest | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const source = typeof body?.source === "string"
    ? body.source.trim().slice(0, MAX_SOURCE_LENGTH) || "unknown"
    : "unknown";

  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const { error } = await serviceClient
    .from("waitlist_signups")
    .upsert(
      { email, source },
      { onConflict: "email", ignoreDuplicates: true },
    );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
