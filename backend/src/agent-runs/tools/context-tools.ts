import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/agent-run";
import { writeContext, type ContextConflict } from "../context-store";
import { defineTool } from "../tool-registry";
import { canSeeContextPath } from "../visible-context";

/** After this many conflicted writes in one run, the gateway stops taking more and tells the agent to report instead. */
export const MAX_CONFLICTED_WRITES = 5;

const SHA256 = /^[0-9a-f]{64}$/;

function requireRun(caller: ToolCaller, tool: string) {
  if (caller.type !== "run") throw new Error(`${tool} can only be called by an agent run`);
  return caller.run;
}

export function createContextTools(client: SupabaseClient) {
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

  return [write];
}
