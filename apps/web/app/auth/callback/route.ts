import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-redirect";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  if (code) {
    const client = await createClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    // A link opened on another device has no PKCE verifier, but the email
    // is still confirmed. Say so instead of showing an error.
    if (error) {
      return NextResponse.redirect(new URL(`/auth/confirmed?next=${encodeURIComponent(next)}`, url.origin));
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
