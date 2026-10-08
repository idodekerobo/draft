import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const backendUrl = process.env.DRAFT_API_BASE_URL;
  if (!backendUrl) {
    console.error("[waitlist] DRAFT_API_BASE_URL is not configured");
    return NextResponse.json({ error: "Waitlist is not configured" }, { status: 503 });
  }

  let response: Response;
  try {
    response = await fetch(`${backendUrl.replace(/\/$/, "")}/waitlist/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error("[waitlist] Profile request failed", error);
    return NextResponse.json({ error: "Could not save answers" }, { status: 502 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: "Could not save answers" }, { status: response.status >= 400 && response.status < 500 ? response.status : 502 });
  }

  return NextResponse.json({ ok: true });
}
