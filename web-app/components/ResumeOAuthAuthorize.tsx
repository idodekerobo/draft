"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { API_URL } from "@/lib/config";

/**
 * Bridges the existing Supabase session into a Better Auth one, then
 * resumes /oauth2/authorize with the (signed, unmodified) query. Two steps
 * because a Set-Cookie from a background fetch to a different origin is
 * silently dropped as a third-party cookie in most browsers regardless of
 * CORS config — only a top-level navigation reliably keeps it: a fetch
 * mints a one-time ticket, then a real navigation redeems it for the
 * session cookie and continues on to /oauth2/authorize.
 */
export function ResumeOAuthAuthorize({ query }: { query: string }) {
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const {
        data: { session },
      } = await createClient().auth.getSession();
      if (!session) {
        if (!cancelled) setError(true);
        return;
      }
      const started = await fetch(`${API_URL}/api/auth/bridge-supabase-session/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!started.ok) {
        if (!cancelled) setError(true);
        return;
      }
      const { ticket } = (await started.json()) as { ticket: string };
      const redirect = encodeURIComponent(`${API_URL}/api/auth/oauth2/authorize?${query}`);
      location.assign(`${API_URL}/api/auth/bridge-supabase-session?ticket=${ticket}&redirect=${redirect}`);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (error) {
    return <p className="error">Could not complete sign-in. Close this window and try again.</p>;
  }
  return <p>Signing you in…</p>;
}
