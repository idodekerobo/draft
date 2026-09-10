"use client";
import { useState } from "react";
import { API_URL } from "@/lib/config";

/**
 * Posts the accept/deny decision to Better Auth's /oauth2/consent endpoint,
 * then redirects to the `redirect_uri` it returns. Unlike /link's device
 * pairing, no Supabase tokens are forwarded — only the Better Auth session
 * cookie (set earlier by ResumeOAuthAuthorize) proves who's consenting.
 */
export function ApproveOAuthConsent({
  query,
  clientId,
  scope,
}: {
  query: string;
  clientId: string;
  scope: string;
}) {
  const [state, setState] = useState<"ready" | "working" | "error">("ready");

  async function decide(accept: boolean) {
    setState("working");
    // `query` is signed by Better Auth — forward it exactly as received.
    const response = await fetch(`${API_URL}/api/auth/oauth2/consent`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accept, oauth_query: query }),
    });
    if (!response.ok) {
      setState("error");
      return;
    }
    const body = (await response.json()) as { redirect_uri?: string };
    if (!body.redirect_uri) {
      setState("error");
      return;
    }
    location.assign(body.redirect_uri);
  }

  return (
    <>
      <p>
        <strong>{clientId}</strong> wants to read your workspace&apos;s context,
        sessions, and skills.
      </p>
      <p className="scope-hint">Requested access: {scope}</p>
      <div className="consent-actions">
        <button disabled={state === "working"} onClick={() => decide(true)}>
          Allow
        </button>
        <button
          disabled={state === "working"}
          className="mode-switch"
          onClick={() => decide(false)}
        >
          Deny
        </button>
      </div>
      {state === "error" && (
        <p className="error">Something went wrong. Close this window and try again.</p>
      )}
    </>
  );
}
