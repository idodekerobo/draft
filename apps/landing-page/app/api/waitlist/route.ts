import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface WaitlistBody {
  email?: unknown;
  source?: unknown;
  attribution?: unknown;
  posthog_distinct_id?: unknown;
  event_id?: unknown;
  client?: { source_url?: unknown };
}

// The backend sees this server's address, so the visitor's own is forwarded for Meta matching.
function clientIp(request: NextRequest): string | undefined {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || undefined;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as WaitlistBody | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const source = typeof body?.source === "string" ? body.source.slice(0, 80) : "unknown";

  if (!EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const backendUrl = process.env.DRAFT_API_BASE_URL;
  if (!backendUrl) {
    console.error("[waitlist] DRAFT_API_BASE_URL is not configured");
    return NextResponse.json({ error: "Waitlist is not configured" }, { status: 503 });
  }

  let response: Response;
  try {
    response = await fetch(`${backendUrl.replace(/\/$/, "")}/waitlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LANDING_PROXY_SECRET ? { "x-draft-landing-secret": process.env.LANDING_PROXY_SECRET } : {}),
      },
      body: JSON.stringify({
        email,
        source,
        attribution: body?.attribution,
        posthog_distinct_id: body?.posthog_distinct_id,
        event_id: body?.event_id,
        client: {
          ip: clientIp(request),
          user_agent: request.headers.get("user-agent") ?? undefined,
          source_url: body?.client?.source_url,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error("[waitlist] Backend request failed", error);
    return NextResponse.json({ error: "Could not save waitlist signup" }, { status: 502 });
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    return NextResponse.json(
      { error: typeof body?.error === "string" ? body.error : "Could not save waitlist signup" },
      { status: response.status >= 400 && response.status < 500 ? response.status : 502 },
    );
  }

  const result = await response.json().catch(() => null) as { signup_token?: unknown } | null;
  if (typeof result?.signup_token !== "string") {
    console.error("[waitlist] Backend did not return a signup token");
    return NextResponse.json({ error: "Could not save waitlist signup" }, { status: 502 });
  }

  return NextResponse.json({ ok: true, signup_token: result.signup_token });
}
