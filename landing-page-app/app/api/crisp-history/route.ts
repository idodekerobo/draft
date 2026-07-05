import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

interface CrispRawMessage {
  fingerprint: number;
  type: string;
  from: string;
  content: unknown;
  timestamp: number;
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRISP_HISTORY_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json() as { session_id?: string };
  if (!body.session_id) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  const websiteId = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID ?? "";
  const apiAuth   = process.env.CRISP_API_AUTH ?? "";
  if (!websiteId || !apiAuth) {
    return NextResponse.json({ messages: [] });
  }

  const upstream = await fetch(
    `https://api.crisp.chat/v1/website/${websiteId}/conversation/${body.session_id}/messages/0`,
    { headers: { Authorization: apiAuth, "X-Crisp-Tier": "plugin" } }
  );

  if (!upstream.ok) return NextResponse.json({ messages: [] });

  const data = await upstream.json() as { data?: CrispRawMessage[] };
  return NextResponse.json({ messages: data.data ?? [] });
}
