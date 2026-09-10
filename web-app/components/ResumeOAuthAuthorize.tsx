"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { API_URL } from "@/lib/config";

/** Bridges the existing Supabase session into a Better Auth session, then resumes /oauth2/authorize with the (signed, unmodified) query. */
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
      const bridged = await fetch(`${API_URL}/api/auth/bridge-supabase-session`, {
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!bridged.ok) {
        if (!cancelled) setError(true);
        return;
      }
      location.assign(`${API_URL}/api/auth/oauth2/authorize?${query}`);
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
