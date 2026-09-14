import type { SourceReadInput, SourceSearchInput } from "draft-core/sources";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { readSource, searchSources } from "../services/sources";

type SearchRequest = Bun.BunRequest<"/workspaces/:id/sources/search">;
type ReadRequest = Bun.BunRequest<"/workspaces/:id/sources/:sourceItemId/read">;

async function parseObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function statusFor(code: string): number {
  if (code === "source_not_found") return 404;
  if (code === "source_superseded" || code === "source_changed") return 409;
  if (code === "search_failed" || code === "read_failed") return 500;
  return 400;
}

export const searchPOST = withAuth<SearchRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  const body = await parseObject(req);
  if (!body) return Response.json({ error: { code: "invalid_query", message: "Expected a JSON object." } }, { status: 400 });
  const result = await searchSources(serviceClient, req.params.id, caller.userId, body as unknown as SourceSearchInput);
  const responseText = JSON.stringify(result.ok ? result.value : { error: result.error });
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "sources.search",
    argsJson: { ...body, cursor: body.cursor ? "[redacted]" : undefined },
    resultBytes: Buffer.byteLength(responseText, "utf8"),
  });
  return new Response(responseText, {
    status: result.ok ? 200 : statusFor(result.error.code),
    headers: { "Content-Type": "application/json" },
  });
});

export const readPOST = withAuth<ReadRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  const body = await parseObject(req);
  if (!body) return Response.json({ error: { code: "invalid_filter", message: "Expected a JSON object." } }, { status: 400 });
  const input = { ...body, source_item_id: req.params.sourceItemId } as unknown as SourceReadInput;
  const result = await readSource(serviceClient, req.params.id, caller.userId, input);
  const responseText = JSON.stringify(result.ok ? result.value : { error: result.error });
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "sources.read",
    argsJson: { source_item_id: req.params.sourceItemId, representation: body.representation, max_bytes: body.max_bytes, cursor: body.cursor ? "[redacted]" : undefined },
    resultBytes: Buffer.byteLength(responseText, "utf8"),
  });
  return new Response(responseText, {
    status: result.ok ? 200 : statusFor(result.error.code),
    headers: { "Content-Type": "application/json" },
  });
});
