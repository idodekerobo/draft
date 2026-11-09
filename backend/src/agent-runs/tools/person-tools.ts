import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/agent-run";
import { createContextExportLink, exportInstructions } from "../../context-export/link";
import { getWorkspaceContext } from "../../services/workspace-context";
import { readSource, searchSources } from "../../services/sources";
import { defineTool } from "../tool-registry";
import { visibleContext } from "../visible-context";

export function callerWorkspaceId(caller: ToolCaller): string {
  return caller.type === "run" ? caller.run.workspaceId : caller.workspaceId;
}

function requireUser(caller: ToolCaller, tool: string) {
  if (caller.type !== "user") throw new Error(`${tool} needs a signed-in person`);
  return caller;
}

const redactCursor = (cursor: string | undefined) => (cursor ? "[redacted]" : undefined);

/** The context and source tools both an MCP client and a run may use. Their output is what the MCP surface has always returned. */
export function createPersonTools(client: SupabaseClient) {
  const list = defineTool({
    name: "context.list",
    description:
      "List dimensions in Draft's maintained business map. Use context for orientation; use sources.search when you need cross-provider evidence beyond the synthesized map.",
    input: z.object({}),
    handler: async ({ caller }) => {
      const result = await getWorkspaceContext(callerWorkspaceId(caller), undefined, client);
      if (!result.ok) return { status: "ok", output: { dimensions: [] as Array<{ name: string; path: string }> } };
      const dimensions = Object.keys(visibleContext(caller, result.snapshot.documents))
        .map((path) => path.match(/^([^/]+)\/index\.md$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => ({ name: match[1]!, path: match[0] }));
      return { status: "ok", output: { dimensions } };
    },
  });

  const read = defineTool({
    name: "context.read",
    description:
      "Read the latest memory or the stable business map. For the latest information, pass dimensions: [\"memory\"] and a period: memory is a chronological log of daily, weekly, and monthly summaries, and the freshest source. Without period, memory returns the whole accumulated log. Other dimensions are current-state background. For direct evidence, search sources and then read the selected source; the calling agent owns investigation and answer generation. A run can also pass paths to read exact documents.",
    input: z.object({
      dimensions: z.array(z.string()).optional().describe("Dimension names to read; omit for all."),
      period: z
        .string()
        .optional()
        .describe("Day YYYY-MM-DD, week week-YYYY-MM-DD (the week's Monday), or month YYYY-MM; aliases today|yesterday|this-week|last-week|this-month|last-month also work. Only valid with dimensions: [\"memory\"]."),
      paths: z.array(z.string()).max(50).optional().describe("Exact document paths to read, such as company/about.md."),
    }),
    handler: async ({ input, caller }) => {
      if (input.period && input.dimensions?.length !== 1) {
        return { status: "ok", output: { error: "period requires exactly one dimension, e.g. dimensions: [\"memory\"]" } };
      }
      const result = await getWorkspaceContext(callerWorkspaceId(caller), { dimension: input.dimensions?.[0], period: input.period }, client);
      if (!result.ok) return { status: "ok", output: { error: result.error } };
      const wanted = input.dimensions?.length ? new Set(input.dimensions) : null;
      const requested = input.paths ? new Set(input.paths) : null;
      const visible = visibleContext(caller, result.snapshot.documents);
      const documents = Object.entries(visible)
        .filter(([path]) => {
          if (requested && !requested.has(path)) return false;
          if (!wanted) return true;
          const match = path.match(/^([^/]+)\//);
          return match ? wanted.has(match[1]!) : false;
        })
        .map(([path, document]) => ({ path, ...document }));
      const missing = input.paths?.filter((path) => !(path in visible));
      return {
        status: "ok",
        output: {
          versionId: result.snapshot.versionId,
          versionNumber: result.snapshot.versionNumber,
          contentHash: result.snapshot.contentHash,
          createdAt: result.snapshot.createdAt,
          documents,
          ...(missing?.length ? { missing } : {}),
        },
        summary: `read ${documents.length} documents`,
      };
    },
  });

  const exportContext = defineTool({
    name: "context.export",
    description:
      "Get a short-lived download link to the full context as a zip of markdown files (all dimensions, including memory). Prefer this over context.read when the user wants the files on disk; the bytes skip your context window. Follow the returned instructions to fetch and unzip.",
    callers: ["user"],
    input: z.object({}),
    handler: async ({ caller }) => {
      const user = requireUser(caller, "context.export");
      const result = await createContextExportLink(user.workspaceId, user.userId, undefined, client);
      if (!result.ok) return { status: "ok", output: { error: result.error } };
      return { status: "ok", output: { ...result.link, instructions: exportInstructions(result.link) } };
    },
  });

  const searchInput = z.object({
    query: z.string().min(1).max(512),
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
    description:
      "Search current cross-provider source evidence using PostgreSQL keyword search. Search covers each source's stored default representation, which may be a summary, rendered source, or mixed content; original transcripts are not universally searchable.",
    callers: ["user"],
    input: searchInput,
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "sources.search");
      const result = await searchSources(client, user.workspaceId, user.userId, input);
      return { status: "ok", output: result.ok ? result.value : { error: result.error } };
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
    description:
      "Read one authorized source by source_item_id. Default returns stored searchable content; request transcript, messages, or structured only when search reports that representation as available. Reads are bounded and version-bound.",
    callers: ["user"],
    input: readInput,
    auditArguments: (input) => ({ ...input, cursor: redactCursor(input.cursor) }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "sources.read");
      const result = await readSource(client, user.workspaceId, user.userId, input);
      return { status: "ok", output: result.ok ? result.value : { error: result.error } };
    },
  });

  return [list, read, exportContext, search, readSourceTool];
}
