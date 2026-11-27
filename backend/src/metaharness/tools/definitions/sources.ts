import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ANY_RUN } from "draft-core/tools";
import { listSources, readSource, searchSources } from "../../../services/sources";
import { syncMembers } from "../../../people/sync-members";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
import { callerWorkspaceId } from "./shared";

/** The sources service names its own failures; a search or read that broke inside is not a refusal. */
function sourceRefusal(error: { code: string; message: string }): ToolHandlerResult {
  if (error.code === "search_failed" || error.code === "read_failed" || error.code === "list_failed") throw new Error(error.message);
  return refuse(error.code, error.message);
}

/** Run input files are named `0000-<id>.md`. Agents sometimes pass that whole stem, so the position is dropped. */
const withoutPositionPrefix = (value: string) => value.trim().replace(/^\d{4}-(?=[0-9a-f]{8}-)/i, "");

const redactCursor = (cursor: string | undefined) => (cursor ? "[redacted]" : undefined);

/** Run callers receive shared sources only; signed-in callers can also see their own private sources. */
export function createSourceTools(client: SupabaseClient) {
  const listInput = z.object({
    provider: z.string().optional(),
    type: z.array(z.string()).optional(),
    since: z.string().optional().describe("Inclusive UTC date or timestamp."),
    until: z.string().optional().describe("Exclusive UTC date or timestamp."),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
  });
  const list = defineTool({
    name: "sources.list",
    mcp: true,
    description: "List current source evidence newest first without searching its content. Filter by provider, type and date; pass next_cursor back as cursor to continue. Use sources.search to find evidence by keywords and sources.read to inspect an item.",
    allowedOrigins: ["person", ...ANY_RUN],
    input: listInput,
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const result = await listSources(client, callerWorkspaceId(caller), caller.origin.kind === "person" ? caller.origin.userId : null, input);
      return result.ok ? { status: "ok", output: result.value } : sourceRefusal(result.error);
    },
  });

  const searchInput = z.object({
    query: z.string().min(1).max(512).optional().describe("Keywords. Optional when person is set: then you get that person's sources, newest first."),
    person: z.union([z.string().uuid(), z.literal("me")]).optional().describe("A person id from people.find, or \"me\" for the person you work for. Only sources that mention one of their ids."),
    provider: z.string().optional(),
    type: z.array(z.string()).optional(),
    since: z.string().optional().describe("Inclusive UTC date or timestamp."),
    until: z.string().optional().describe("Exclusive UTC date or timestamp."),
    limit: z.number().int().min(1).max(100).optional(),
    max_bytes: z.number().int().min(1024).max(262144).optional(),
    cursor: z.string().optional(),
  });
  const search = defineTool({
    name: "sources.search",
    mcp: true,
    description:
      "Search current cross-provider source evidence using PostgreSQL keyword search. Search covers each source's stored default representation, which may be a summary, rendered source, or mixed content; original transcripts are not universally searchable. " +
      "Pass person (an id from people.find, or \"me\") to get only the sources that mention that person's email, Slack, Linear or other ids; the query is then optional. " +
      "A source that names someone only by first name, with no id, is not matched this way.",
    allowedOrigins: ["person", ...ANY_RUN],
    input: searchInput,
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const workspaceId = callerWorkspaceId(caller);
      const viewerUserId = caller.origin.kind === "person" ? caller.origin.userId : null;
      if (input.person && caller.origin.kind === "person") await syncMembers(client, workspaceId);
      const personUserId = caller.onBehalfOf;
      const result = await searchSources(client, workspaceId, viewerUserId, input, personUserId);
      return result.ok ? { status: "ok", output: result.value } : sourceRefusal(result.error);
    },
  });

  const readInput = z.object({
    source_item_id: z.string().transform(withoutPositionPrefix).pipe(z.string().uuid()),
    representation: z.enum(["default", "transcript", "messages", "structured"]).optional(),
    max_bytes: z.number().int().min(1024).max(262144).optional(),
    cursor: z.string().optional(),
  });
  const readSourceTool = defineTool({
    name: "sources.read",
    mcp: true,
    description:
      "Read one authorized source by source_item_id. Default returns stored searchable content; request transcript, messages, or structured only when search reports that representation as available. Reads are bounded and version-bound.",
    allowedOrigins: ["person", ...ANY_RUN],
    input: readInput,
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const result = await readSource(client, callerWorkspaceId(caller), caller.origin.kind === "person" ? caller.origin.userId : null, input);
      return result.ok ? { status: "ok", output: result.value } : sourceRefusal(result.error);
    },
  });

  return [list, search, readSourceTool];
}
