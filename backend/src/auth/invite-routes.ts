import { loadConfig } from "../config";
import { serviceClient } from "../db/client";
import { generateInviteToken } from "./generate-token";
import { withAuth } from "./withAuth";

type InviteTokenRequest = Bun.BunRequest<"/invites/:token">;
type InviteAcceptRequest = Bun.BunRequest<"/invites/:token/accept">;
type MineRequest = Bun.BunRequest<"/invites/mine">;

const INVITE_TTL_MS = 30 * 86_400_000;

async function expire(id: string): Promise<void> { await serviceClient.from("invites").update({ status: "expired" }).eq("id", id).eq("status", "active"); }

// for now, one invite link per (org, team) is reused across requests
export const mineGET = withAuth<MineRequest>(async (_req, caller) => {
  const { data: user, error: userError } = await serviceClient
    .from("users").select("organization_id, primary_team_id").eq("id", caller.userId).maybeSingle();
  if (userError) return Response.json({ error: "lookup_failed" }, { status: 500 });
  if (!user?.organization_id || !user.primary_team_id) {
    return Response.json({ error: "no_team" }, { status: 404 });
  }

  const { data: existing, error: existingError } = await serviceClient
    .from("invites")
    .select("token, expires_at")
    .eq("organization_id", user.organization_id)
    .eq("team_id", user.primary_team_id)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) return Response.json({ error: "lookup_failed" }, { status: 500 });

  if (existing) {
    return Response.json({
      url: `${loadConfig().appUrl}/invite/${existing.token}`,
      expiresAt: existing.expires_at,
    });
  }

  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const { error: insertError } = await serviceClient.from("invites").insert({
    organization_id: user.organization_id,
    team_id: user.primary_team_id,
    token,
    expires_at: expiresAt,
  });
  if (insertError) return Response.json({ error: "create_failed" }, { status: 500 });

  return Response.json({ url: `${loadConfig().appUrl}/invite/${token}`, expiresAt });
});

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
