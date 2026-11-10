import { parseUserId, parseWorkspaceId } from "draft-core/agent-run";
import { visibleContext } from "../agent-runs/visible-context";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { contextExportSettings } from "../config";
import { ContextExportTokenError, verifyContextExportToken } from "../context-export/token";
import { serviceClient } from "../db/client";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { buildContextExport } from "../services/context-export";
import { getWorkspaceContext } from "../services/workspace-context";

type RedeemRequest = Bun.BunRequest<"/context-exports/:token">;

async function zipResponse(workspaceId: string, userId: string, via: string, logAsAgent: boolean): Promise<Response> {
  const result = await getWorkspaceContext(workspaceId);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  let exported: ReturnType<typeof buildContextExport>;
  try {
    // The link is a person's access in an agent's hands, so it shows what that person may see.
    const caller = { type: "user" as const, userId: parseUserId(userId), workspaceId: parseWorkspaceId(workspaceId), via: "cli" as const };
    exported = buildContextExport({ ...result.snapshot, documents: visibleContext(caller, result.snapshot.documents) });
  } catch (error) {
    console.error("context export: build failed", error);
    return Response.json({ error: "export_failed" }, { status: 500 });
  }

  if (logAsAgent) void recordAgentQueryLog(serviceClient, {
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
  // A signed link is what a person hands to an agent, so a download through one is agent usage.
  return zipResponse(claims.workspaceId, claims.userId, "link", true);
}
