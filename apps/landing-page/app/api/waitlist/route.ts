import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { email?: unknown; source?: unknown } | null;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, source }),
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

  return NextResponse.json({ ok: true });
}
