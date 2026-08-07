import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { assertSafeDocumentPath } from "../synthesis/context-version-files";
import type { WorkspaceContextVersionRow } from "../types/tables";

type ContextRequest = Bun.BunRequest<"/workspaces/:id/context">;
type DocumentRequest = Bun.BunRequest<"/workspaces/:id/context/documents/*">;

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
    paths: Object.keys(version.documents_json),
  });
});

export const documentGET = withAuth<DocumentRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  // Bun does not expose the "*" wildcard segment via req.params (verified
  // against bun 1.3.11: params only ever contains named :id) — derive it
  // from the URL path instead, stripping the known prefix up to and
  // including "/documents/".
  const url = new URL(req.url);
  const prefix = `/workspaces/${req.params.id}/context/documents/`;
  const encodedPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
    assertSafeDocumentPath(path);
  } catch {
    return Response.json({ error: "invalid_path" }, { status: 400 });
  }

  const { data: version, error } = await serviceClient
    .from("workspace_context_versions")
    .select("documents_json")
    .eq("workspace_id", req.params.id)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle<Pick<WorkspaceContextVersionRow, "documents_json">>();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const doc = version?.documents_json[path];
  if (!doc) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({ path, content: doc.content, sha256: doc.sha256 });
});
