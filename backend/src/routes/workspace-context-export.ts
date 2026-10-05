import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { contextExportSettings } from "../config";
import { createContextExportLink } from "../context-export/link";
import { ContextExportTokenError, verifyContextExportToken } from "../context-export/token";
import { serviceClient } from "../db/client";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { buildContextExport } from "../services/context-export";
import { getWorkspaceContext } from "../services/workspace-context";

type ExportRequest = Bun.BunRequest<"/workspaces/:id/context/export">;
type ExportLinkRequest = Bun.BunRequest<"/workspaces/:id/context/export-links">;
type RedeemRequest = Bun.BunRequest<"/context-exports/:token">;

async function zipResponse(workspaceId: string, userId: string, via: string): Promise<Response> {
  const result = await getWorkspaceContext(workspaceId);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  let exported: ReturnType<typeof buildContextExport>;
  try {
    exported = buildContextExport(result.snapshot);
  } catch (error) {
    console.error("context export: build failed", error);
    return Response.json({ error: "export_failed" }, { status: 500 });
  }

  void recordAgentQueryLog(serviceClient, {
    workspaceId,
    userId,
    command: "context.export",
    argsJson: { via, versionNumber: result.snapshot.versionNumber },
    resultBytes: exported.bytes.byteLength,
  });

  return new Response(exported.bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${exported.fileName}"`,
      "cache-control": "no-store",
      "access-control-expose-headers": "content-disposition",
    },
  });
}

export const exportGET = withAuth<ExportRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return zipResponse(req.params.id, caller.userId, "authenticated");
});

export const exportLinkPOST = withAuth<ExportLinkRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const result = await createContextExportLink(req.params.id, caller.userId);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result.link);
});

// No auth header: the signed token is the capability. Access is re-checked
// for the signed user so a removed member's links stop working.
export async function redeemGET(req: RedeemRequest): Promise<Response> {
  let claims: ReturnType<typeof verifyContextExportToken>;
  try {
    claims = verifyContextExportToken(req.params.token, contextExportSettings().secret);
  } catch (error) {
    if (error instanceof ContextExportTokenError) {
      return Response.json({ error: "invalid_or_expired_link" }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const denied = await assertWorkspaceAccess(claims.workspaceId, claims.userId);
  if (denied) return denied;
  return zipResponse(claims.workspaceId, claims.userId, "link");
}
