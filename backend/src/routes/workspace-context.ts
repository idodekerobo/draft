import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import type { WorkspaceContextVersionRow } from "../types/tables";

type ContextRequest = Bun.BunRequest<"/workspaces/:id/context">;

export const contextGET = withAuth<ContextRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data: version, error } = await serviceClient
    .from("workspace_context_versions")
    .select("*")
    .eq("workspace_id", req.params.id)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle<WorkspaceContextVersionRow>();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!version) return Response.json({ error: "no_context_yet" }, { status: 404 });

  return Response.json({
    versionId: version.id,
    versionNumber: version.version_number,
    contentHash: version.content_hash,
    creationReason: version.creation_reason,
    createdAt: version.created_at,
    documents: version.documents_json,
  });
});
