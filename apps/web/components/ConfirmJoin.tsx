"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { ApiError, apiFetch } from "@/lib/api";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { ORG_NAME_KEY } from "@/lib/workspace";

type JoinState =
  | { kind: "ready" }
  | { kind: "joining" }
  | { kind: "session_expired" }
  | { kind: "error"; message: string };

const ERROR_COPY: Record<string, string> = {
  expired: "This invitation has expired. Ask your admin for a new link.",
  revoked: "This invitation was revoked. Ask your admin for a new link.",
  not_found: "This invitation does not exist.",
  already_in_another_organization: "You already belong to another organization. Contact the founder to move workspaces.",
};

export function ConfirmJoin({ token, email, organizationName, teamName }: { token: string; email: string; organizationName: string; teamName: string }) {
  const router = useRouter();
  const { track } = useAnalytics();
  const [state, setState] = useState<JoinState>({ kind: "ready" });
  const invitePath = `/invite/${encodeURIComponent(token)}`;

  useEffect(() => { track("onboarding_step_viewed", { step: "confirm_join" }); }, [track]);

  async function join() {
    setState({ kind: "joining" });
    try {
      await apiFetch(`/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
      try { sessionStorage.setItem(ORG_NAME_KEY, organizationName); } catch {}
      track("invite_joined", {});
      router.push("/welcome");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setState({ kind: "session_expired" });
      else if (error instanceof ApiError && error.status === 0) setState({ kind: "error", message: "Could not reach Draft. Check your connection and try again." });
      else setState({ kind: "error", message: ERROR_COPY[(error as ApiError).code] ?? "We could not accept this invitation. Try again." });
    }
  }

  async function switchAccount(nextPath: string) {
    await createClient().auth.signOut();
    location.assign(nextPath);
  }

  if (state.kind === "session_expired") {
    return (
      <>
        <h1>Sign in again</h1>
        <p>Your session expired. Sign in again to join {organizationName}. Your invitation still works.</p>
        <button type="button" className="ui-btn ui-btn--primary ui-btn--wide" onClick={() => void switchAccount(`/login?next=${encodeURIComponent(invitePath)}`)}>
          Sign in again
        </button>
      </>
    );
  }

  return (
    <>
      <h1>Join {organizationName}</h1>
      <p className="ui-flow__subtitle">{teamName}</p>
      <p className="confirm-join__email">Joining as <strong>{email}</strong></p>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--wide" onClick={() => void join()} disabled={state.kind === "joining"}>
        {state.kind === "joining" ? "Joining…" : "Join"}
      </button>
      {state.kind === "error" && <p className="error" role="alert">{state.message}</p>}
      <hr className="ui-flow__divider" />
      <button type="button" className="ui-link" onClick={() => void switchAccount(invitePath)}>Use a different account</button>
    </>
  );
}
