import { serviceClient } from "../db/client";
import type { WorkspaceContextVersionRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";

export interface WorkspaceContextSnapshot {
  versionId: string;
  versionNumber: number;
  contentHash: string;
  creationReason: string;
  createdAt: string;
  documents: WorkspaceContextVersionRow["documents_json"];
}

export type GetWorkspaceContextResult =
  | { ok: true; snapshot: WorkspaceContextSnapshot }
  | { ok: false; status: number; error: string };

/** Caller must already have run assertWorkspaceAccess — this trusts workspaceId. */
export async function getWorkspaceContext(workspaceId: string): Promise<GetWorkspaceContextResult> {
  const { data: version, error } = await serviceClient
    .from("workspace_context_versions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle<WorkspaceContextVersionRow>();

  if (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "workspace_context_read_failed", error });
    return { ok: false, status: 500, error: error.message };
  }
  if (!version) return { ok: false, status: 404, error: "no_context_yet" };

  return {
    ok: true,
    snapshot: {
      versionId: version.id,
      versionNumber: version.version_number,
      contentHash: version.content_hash,
      creationReason: version.creation_reason,
      createdAt: version.created_at,
      documents: version.documents_json,
    },
  };
}
