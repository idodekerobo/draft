import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createContextExportLink, exportInstructions } from "../../../context-export/link";
import { getWorkspaceContext } from "../../../services/workspace-context";
import { writeContext, type ContextConflict } from "../../context/context-store";
import { canSeeContextPath, visibleContext } from "../../context/visible-context";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
import { callerWorkspaceId, requireRun, requireUser } from "./shared";

/** After this many conflicted writes in one run, the gateway stops taking more and tells the agent to report instead. */
export const MAX_CONFLICTED_WRITES = 5;

const SHA256 = /^[0-9a-f]{64}$/;

const CONTEXT_MESSAGES: Record<string, string> = {
  no_context_yet: "This workspace has no context yet.",
  period_not_found: "No memory document exists for that period.",
};

/** A context lookup that failed: a missing thing or a bad period is a refusal, a database failure is not. */
function contextRefusal(result: { status: number; error: string }): ToolHandlerResult {
  if (result.status === 404) return refuse(result.error, CONTEXT_MESSAGES[result.error] ?? result.error);
  if (result.status === 400) return refuse("invalid_period", result.error);
  throw new Error(result.error);
}

/** The sources service names its own failures; a search or read that broke inside is not a refusal. */
function sourceRefusal(error: { code: string; message: string }): ToolHandlerResult {
  if (error.code === "search_failed" || error.code === "read_failed") throw new Error(error.message);
  return refuse(error.code, error.message);
}

/** The context tools: read, list and export for a person or a run, and write for a run. */
export function createContextTools(client: SupabaseClient) {
  const list = defineTool({
    name: "context.list",
    mcp: true,
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
    mcp: true,
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
        return refuse("invalid_period", "period requires exactly one dimension, e.g. dimensions: [\"memory\"]");
      }
      const result = await getWorkspaceContext(callerWorkspaceId(caller), { dimension: input.dimensions?.[0], period: input.period }, client);
      if (!result.ok) return contextRefusal(result);
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
          creationReason: result.snapshot.creationReason,
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
    mcp: true,
    description:
      "Get a short-lived download link to the full context as a zip of markdown files (all dimensions, including memory). Prefer this over context.read when the user wants the files on disk; the bytes skip your context window. Follow the returned instructions to fetch and unzip.",
    callers: ["user"],
    input: z.object({}),
    handler: async ({ caller }) => {
      const user = requireUser(caller, "context.export");
      const result = await createContextExportLink(user.workspaceId, user.userId, undefined, client);
      if (!result.ok) return contextRefusal(result);
      return { status: "ok", output: { ...result.link, instructions: exportInstructions(result.link) } };
    },
  });

  const write = defineTool({
    name: "context.write",
    callers: ["run"],
    description:
      "Write Markdown documents to the company's shared context. Each change is checked against that document only. " +
      "Changes that do not conflict are written. For each one that changed since you read it, you get its current content and sha back: merge your change and write again with that sha as baseSha, or drop it.",
    input: z.object({
      summary: z.string().min(1).max(500),
      changes: z
        .array(
          z.object({
            path: z.string().min(1),
            content: z.string(),
            baseSha: z.string().regex(SHA256).nullable().optional(),
          }),
        )
        .min(1),
    }),
    checkLimits: (limits, input) => {
      const prefixes = limits?.pathPrefixes;
      if (!prefixes) return null;
      const outside = input.changes.find((change) => !prefixes.some((prefix) => change.path.startsWith(prefix)));
      return outside ? `${outside.path} is outside the paths this run may write` : null;
    },
    auditArguments: (input) => ({
      summary: input.summary,
      changes: input.changes.map((change) => ({ path: change.path, bytes: Buffer.byteLength(change.content), baseSha: change.baseSha })),
    }),
    handler: async ({ input, caller }) => {
      const run = requireRun(caller, "context.write");

      const { count, error } = await client
        .from("agent_run_tool_calls")
        .select("id", { count: "exact", head: true })
        .eq("agent_run_id", run.id)
        .eq("tool_name", "context.write")
        .eq("status", "conflict");
      if (error) throw error;
      if ((count ?? 0) >= MAX_CONFLICTED_WRITES) {
        return {
          status: "conflict",
          output: { retryable: false, message: "Too many conflicted writes in this run. Stop retrying. Drop the change." },
          summary: "retry cap reached",
        };
      }

      const result = await writeContext(client, {
        workspaceId: run.workspaceId,
        agentRunId: run.id,
        baseVersionId: run.inputs.contextVersionId,
        changes: input.changes,
        summary: input.summary,
        reason: run.kind === "synthesis" ? "synthesis" : "agent_write",
      });

      if (result.status === "unchanged") return { status: "ok", output: { unchanged: true }, summary: "no change" };

      const conflicts = result.conflicts.map((conflict: ContextConflict) =>
        canSeeContextPath(caller, conflict.path) ? conflict : { ...conflict, currentContent: null },
      );
      const written = result.status === "committed" ? result.written : [];
      const conflictSummary = `conflict on ${conflicts.map((conflict) => conflict.path).join(", ")}`;
      const output = {
        ...(result.status === "committed" ? { versionId: result.versionId, versionNumber: result.versionNumber } : {}),
        written,
        ...(conflicts.length > 0 ? { conflicts, retryable: true, retriesLeft: MAX_CONFLICTED_WRITES - (count ?? 0) - 1 } : {}),
      };
      if (conflicts.length === 0) return { status: "ok", output, summary: `wrote ${written.join(", ")}` };
      return {
        status: "conflict",
        output,
        summary: written.length > 0 ? `wrote ${written.join(", ")}; ${conflictSummary}` : conflictSummary,
      };
    },
  });

  return [list, read, exportContext, write];
}
