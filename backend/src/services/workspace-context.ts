import { serviceClient } from "../db/client";
import type { WorkspaceContextVersionRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";
import { resolveMemoryPeriod, type ResolvedMemoryPeriod } from "../synthesis/memory-period";

export interface WorkspaceContextSnapshot {
  versionId: string;
  versionNumber: number;
  contentHash: string;
  creationReason: string;
  createdAt: string;
  documents: WorkspaceContextVersionRow["documents_json"];
}

// Only "memory" supports `period` today. `dimension` here is purely for
// validating that expectation -- it never filters the rest of the snapshot;
// callers that want other dimensions filter the returned `documents`
// themselves (see mcp/tools.ts context.read and the CLI).
export interface WorkspaceContextFilter {
  dimension?: string;
  period?: string;
}

export type GetWorkspaceContextResult =
  | { ok: true; snapshot: WorkspaceContextSnapshot }
  | { ok: false; status: number; error: string };

/**
 * Caller must already have run assertWorkspaceAccess — this trusts workspaceId.
 * With no `filter.period`, returns the full documents map exactly as before.
 * With `filter.period`, resolves it against the workspace's timezone (memory
 * is the only period-keyed dimension) and narrows `documents` to that single
 * period document -- this is the one function both the HTTP route (CLI) and
 * the MCP `context.read` tool call, so alias/id resolution can't drift
 * between the two surfaces.
 */
export async function getWorkspaceContext(
  workspaceId: string,
  filter?: WorkspaceContextFilter,
): Promise<GetWorkspaceContextResult> {
  // The version and (when a period is requested) timezone lookups are
  // independent of each other -- fire both at once instead of paying two
  // sequential round trips.
  const versionQuery = serviceClient
    .from("workspace_context_versions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle<WorkspaceContextVersionRow>();
  const timezoneQuery = filter?.period
    ? serviceClient.from("workspaces").select("timezone").eq("id", workspaceId).single<{ timezone: string }>()
    : null;

  const [{ data: version, error }, timezoneResult] = await Promise.all([versionQuery, timezoneQuery]);

  if (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "workspace_context_read_failed", error });
    return { ok: false, status: 500, error: error.message };
  }
  if (!version) return { ok: false, status: 404, error: "no_context_yet" };

  let documents = version.documents_json;

  if (filter?.period) {
    const dimension = filter.dimension ?? "memory";
    if (dimension !== "memory") {
      return { ok: false, status: 400, error: `dimension does not support periods: ${dimension}` };
    }

    const workspaceError = timezoneResult!.error;
    if (workspaceError) {
      recordRouteError({ workspaceId, operation: "read", errorCode: "workspace_context_read_failed", error: workspaceError });
      return { ok: false, status: 500, error: workspaceError.message };
    }

    let resolved: ResolvedMemoryPeriod;
    try {
      resolved = resolveMemoryPeriod(filter.period, timezoneResult!.data!.timezone);
    } catch (parseError) {
      return {
        ok: false,
        status: 400,
        error: parseError instanceof Error ? parseError.message : "invalid period",
      };
    }

    const doc = documents[resolved.path];
    if (!doc) return { ok: false, status: 404, error: "period_not_found" };
    documents = { [resolved.path]: doc };
  }

  return {
    ok: true,
    snapshot: {
      versionId: version.id,
      versionNumber: version.version_number,
      contentHash: version.content_hash,
      creationReason: version.creation_reason,
      createdAt: version.created_at,
      documents,
    },
  };
}
