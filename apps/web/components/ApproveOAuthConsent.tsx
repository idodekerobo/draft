"use client";
import { API_URL } from "@/lib/config";

/**
 * Navigates (not fetches) to a top-level bridge for Better Auth's POST-only
 * /oauth2/consent — a background fetch with credentials: "include" would
 * need to send the session cookie cross-origin, which is silently dropped
 * as third-party in most browsers (same issue as the Supabase-session
 * bridge; see backend/src/auth/oauth-consent-redirect.ts). `query` is
 * signed by Better Auth and forwarded exactly as received.
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
  function decide(accept: boolean) {
    const oauthQuery = encodeURIComponent(query);
    location.assign(`${API_URL}/oauth2/consent-redirect?accept=${accept}&oauth_query=${oauthQuery}`);
  }

  return (
    <>
      <p>
        <strong>{clientId}</strong> wants to read your workspace&apos;s context,
        sessions, and skills.
      </p>
      <p className="scope-hint">Requested access: {scope}</p>
      <div className="consent-actions">
        <button onClick={() => decide(true)}>Allow</button>
        <button className="mode-switch" onClick={() => decide(false)}>
          Deny
        </button>
      </div>
    </>
  );
}
