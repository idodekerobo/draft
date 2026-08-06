import { serviceClient } from "../db/client";
import { withAuth } from "./withAuth";

type InviteTokenRequest = Bun.BunRequest<"/invites/:token">;
type InviteAcceptRequest = Bun.BunRequest<"/invites/:token/accept">;

async function expire(id: string): Promise<void> { await serviceClient.from("invites").update({ status: "expired" }).eq("id", id).eq("status", "active"); }

export async function resolveGET(req: InviteTokenRequest): Promise<Response> {
  const { data: invite, error } = await serviceClient.from("invites")
    .select("id, organization_id, team_id, status, expires_at").eq("token", req.params.token).maybeSingle();
  if (error) return Response.json({ error: "lookup_failed" }, { status: 500 });
  if (!invite) return Response.json({ error: "not_found" }, { status: 404 });
  if (invite.status !== "active") return Response.json({ error: invite.status }, { status: 410 });
  if (new Date(invite.expires_at).getTime() <= Date.now()) { await expire(invite.id); return Response.json({ error: "expired" }, { status: 410 }); }
  const [{ data: org }, { data: team }] = await Promise.all([
    serviceClient.from("organizations").select("name").eq("id", invite.organization_id).single(),
    serviceClient.from("teams").select("name").eq("id", invite.team_id).single(),
  ]);
  return Response.json({ organization_name: org?.name, team_name: team?.name });
}

export const acceptPOST = withAuth<InviteAcceptRequest>(async (req, caller) => {
  const { data: invite, error: lookupError } = await serviceClient.from("invites")
    .select("id, organization_id, team_id, status, expires_at").eq("token", req.params.token).maybeSingle();
  if (lookupError) return Response.json({ error: "lookup_failed" }, { status: 500 });
  if (!invite) return Response.json({ error: "not_found" }, { status: 404 });
  if (invite.status !== "active") return Response.json({ error: invite.status }, { status: 410 });
  if (new Date(invite.expires_at).getTime() <= Date.now()) { await expire(invite.id); return Response.json({ error: "expired" }, { status: 410 }); }

  const { data: existing, error: existingError } = await serviceClient
    .from("users").select("organization_id").eq("id", caller.userId).maybeSingle();
  if (existingError || !existing) {
    console.error("invite accept: users row missing for authenticated caller", {
      userId: caller.userId,
      inviteId: invite.id,
      error: existingError?.message,
    });
    return Response.json({ error: "accept_failed" }, { status: 500 });
  }
  if (existing.organization_id && existing.organization_id !== invite.organization_id) {
    return Response.json({ error: "already_in_another_organization" }, { status: 409 });
  }

  const { data: updated, error } = await serviceClient.from("users")
    .update({ organization_id: invite.organization_id, primary_team_id: invite.team_id, status: "active" })
    .eq("id", caller.userId)
    .select("id");
  if (error || !updated || updated.length === 0) {
    // Supabase returns an empty array when an update matches no rows.
    console.error("invite accept: update affected zero rows", {
      userId: caller.userId,
      inviteId: invite.id,
      error: error?.message,
    });
    return Response.json({ error: "accept_failed" }, { status: 500 });
  }
  return Response.json({ organization_id: invite.organization_id, team_id: invite.team_id });
});
