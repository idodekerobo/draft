import { API_URL } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "@/components/AuthForm";
import { AcceptInvite } from "@/components/AcceptInvite";
export default async function Invite({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const response = await fetch(
    `${API_URL}/invites/${encodeURIComponent(token)}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "not_found" }));
    const copy: Record<string, string> = {
      not_found: "This invitation does not exist.",
      expired: "This invitation has expired.",
      revoked: "This invitation was revoked.",
    };
    return (
      <main className="card">
        <h1>Invitation unavailable</h1>
        <p className="error">
          {copy[body.error] || "This invitation is unavailable."}
        </p>
      </main>
    );
  }
  const invite = await response.json();
  const client = await createClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  return (
    <main className="card">
      <h1>Join {invite.organization_name}</h1>
      <p>You’ve been invited to the {invite.team_name} team.</p>
      {user ? (
        <AcceptInvite token={token} />
      ) : (
        <AuthForm next={`/invite/${encodeURIComponent(token)}`} />
      )}
    </main>
  );
}
