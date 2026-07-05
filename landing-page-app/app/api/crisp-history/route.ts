import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "views://app",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

interface CrispRawMessage {
  fingerprint: number;
  type: string;
  from: string;
  content: unknown;
  timestamp: number;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRISP_HISTORY_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const body = await req.json() as { session_id?: string };
  if (!body.session_id) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400, headers: CORS_HEADERS });
  }

  const websiteId    = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID ?? "";
  const apiIdentifier = process.env.CRISP_API_IDENTIFIER ?? "";
  const apiKey        = process.env.CRISP_API_KEY ?? "";

  console.log("[crisp-history] request", { session_id: body.session_id, has_website_id: !!websiteId, has_identifier: !!apiIdentifier, has_key: !!apiKey });

  if (!websiteId || !apiIdentifier || !apiKey) {
    console.log("[crisp-history] missing env vars");
    return NextResponse.json({ messages: [] }, { headers: CORS_HEADERS });
  }

  const apiAuth = `Basic ${Buffer.from(`${apiIdentifier}:${apiKey}`).toString("base64")}`;
  const url = `https://api.crisp.chat/v1/website/${websiteId}/conversation/${body.session_id}/messages`;
  console.log("[crisp-history] calling crisp", url);

  const upstream = await fetch(url, {
    headers: { Authorization: apiAuth, "X-Crisp-Tier": "plugin" },
  });

  const rawBody = await upstream.text();
  console.log("[crisp-history] crisp response", { status: upstream.status, body: rawBody });

  if (!upstream.ok) {
    return NextResponse.json({ messages: [] }, { headers: CORS_HEADERS });
  }

  const data = JSON.parse(rawBody) as { data?: CrispRawMessage[] };
  return NextResponse.json({ messages: data.data ?? [] }, { headers: CORS_HEADERS });
}
