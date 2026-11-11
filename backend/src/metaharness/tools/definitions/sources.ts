import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readSource, searchSources } from "../../../services/sources";
import { syncMembers } from "../../../people/sync-members";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
import { requireUser } from "./shared";

/** The sources service names its own failures; a search or read that broke inside is not a refusal. */
function sourceRefusal(error: { code: string; message: string }): ToolHandlerResult {
  if (error.code === "search_failed" || error.code === "read_failed") throw new Error(error.message);
  return refuse(error.code, error.message);
}

const redactCursor = (cursor: string | undefined) => (cursor ? "[redacted]" : undefined);

/** The source tools. They need a person: sources are shown as that person may see them. */
export function createSourceTools(client: SupabaseClient) {
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
    callers: ["user"],
    input: searchInput,
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "sources.search");
      if (input.person) await syncMembers(client, user.workspaceId);
      const result = await searchSources(client, user.workspaceId, user.userId, input);
      return result.ok ? { status: "ok", output: result.value } : sourceRefusal(result.error);
    },
  });

  const readInput = z.object({
    source_item_id: z.string().uuid(),
    representation: z.enum(["default", "transcript", "messages", "structured"]).optional(),
    max_bytes: z.number().int().min(1024).max(262144).optional(),
    cursor: z.string().optional(),
  });
  const readSourceTool = defineTool({
    name: "sources.read",
    mcp: true,
    description:
      "Read one authorized source by source_item_id. Default returns stored searchable content; request transcript, messages, or structured only when search reports that representation as available. Reads are bounded and version-bound.",
    callers: ["user"],
    input: readInput,
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "sources.read");
      const result = await readSource(client, user.workspaceId, user.userId, input);
      return result.ok ? { status: "ok", output: result.value } : sourceRefusal(result.error);
    },
  });

  return [search, readSourceTool];
}
