import { FlowShell } from "draft-shared-ui";
import { API_URL } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "@/components/AuthForm";
import { ConfirmJoin } from "@/components/ConfirmJoin";
import { TrackOnMount } from "@/components/TrackOnMount";

const UNAVAILABLE_COPY: Record<string, string> = {
  not_found: "This invitation does not exist.",
  expired: "This invitation has expired. Ask your admin for a new link.",
  revoked: "This invitation was revoked. Ask your admin for a new link.",
};

type InviteLookup =
  | { kind: "ok"; organization_name: string; team_name: string }
  | { kind: "unavailable"; error: string }
  | { kind: "api_down" };

async function lookupInvite(token: string): Promise<InviteLookup> {
  try {
    const response = await fetch(`${API_URL}/invites/${encodeURIComponent(token)}`, { cache: "no-store" });
    if (response.status >= 500) return { kind: "api_down" };
    const body = await response.json().catch(() => ({ error: "not_found" }));
    if (!response.ok) return { kind: "unavailable", error: body.error };
    return { kind: "ok", organization_name: body.organization_name, team_name: body.team_name };
  } catch {
    return { kind: "api_down" };
  }
}

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitePath = `/invite/${encodeURIComponent(token)}`;
  const invite = await lookupInvite(token);

  if (invite.kind === "api_down") {
    return (
      <FlowShell>
        <h1>We could not load this invitation</h1>
        <p>Draft is not responding right now. Your invitation link still works.</p>
        <a className="ui-btn ui-btn--primary" href={invitePath}>Try again</a>
      </FlowShell>
    );
  }

  if (invite.kind === "unavailable") {
    return (
      <FlowShell>
        <h1>Invitation unavailable</h1>
        <p>{UNAVAILABLE_COPY[invite.error] ?? "This invitation is unavailable."}</p>
      </FlowShell>
    );
  }

  const client = await createClient();
  const {
    data: { user },
  } = await client.auth.getUser();

  return (
    <FlowShell>
      <TrackOnMount event="invite_viewed" />
      {user ? (
        <ConfirmJoin token={token} email={user.email ?? ""} organizationName={invite.organization_name} teamName={invite.team_name} />
      ) : (
        <>
          <h1>You&apos;re invited to join {invite.organization_name}</h1>
          <p>{invite.team_name}. Create an account or sign in to join.</p>
          <AuthForm next={invitePath} initialMode="signup" allowSignup />
        </>
      )}
    </FlowShell>
  );
}
