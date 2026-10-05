import { contextExportSettings } from "../config";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { exportFileName } from "../services/context-export";
import { CONTEXT_EXPORT_TTL_MS, createContextExportToken } from "./token";

export interface ContextExportLink {
  url: string;
  expiresAt: string;
  fileName: string;
}

export type CreateContextExportLinkResult =
  | { ok: true; link: ContextExportLink }
  | { ok: false; status: number; error: string };

/** Caller must already have run assertWorkspaceAccess. Shared by the HTTP route and the MCP tool. */
export async function createContextExportLink(
  workspaceId: string,
  userId: string,
  now = Date.now(),
): Promise<CreateContextExportLinkResult> {
  // Only the version number is needed for the file name; skip reading every document.
  const { data: version, error } = await serviceClient
    .from("workspace_context_versions")
    .select("version_number")
    .eq("workspace_id", workspaceId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle<{ version_number: number }>();
  if (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "workspace_context_read_failed", error });
    return { ok: false, status: 500, error: error.message };
  }
  if (!version) return { ok: false, status: 404, error: "no_context_yet" };

  const settings = contextExportSettings();
  if (!settings.secret) {
    console.error("createContextExportLink: CONTEXT_EXPORT_SECRET is not configured");
    return { ok: false, status: 500, error: "export_not_configured" };
  }
  const exp = now + CONTEXT_EXPORT_TTL_MS;
  const token = createContextExportToken({ workspaceId, userId, exp }, settings.secret);

  return {
    ok: true,
    link: {
      url: `${settings.apiBaseUrl}/context-exports/${token}`,
      expiresAt: new Date(exp).toISOString(),
      fileName: exportFileName(version.version_number, new Date(now)),
    },
  };
}

export function exportInstructions(link: ContextExportLink): string {
  return `Run: curl -L "${link.url}" -o draft-context.zip && unzip draft-context.zip. The link expires at ${link.expiresAt}. The zip holds one draft-context/ folder of markdown files; read README.md in it first.`;
}
