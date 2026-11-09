import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/agent-run";
import { writeContext, type ContextConflict } from "../context-store";
import { defineTool } from "../tool-registry";
import { canSeeContextPath } from "../visible-context";

/** After this many conflicted writes in one run, the gateway stops taking more and tells the agent to report instead. */
export const MAX_CONFLICTED_WRITES = 3;

const SHA256 = /^[0-9a-f]{64}$/;

function requireRun(caller: ToolCaller, tool: string) {
  if (caller.type !== "run") throw new Error(`${tool} can only be called by an agent run`);
  return caller.run;
}

export function createContextTools(client: SupabaseClient) {
  const write = defineTool({
    name: "context.write",
    description:
      "Write Markdown documents to the company's shared context. Each change is checked against that document only. " +
      "If it changed since you read it, you get its current content and sha back: merge your change and write again with that sha as baseSha, drop it, or report it with request_input.",
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
          output: { retryable: false, message: "Too many conflicted writes in this run. Stop retrying. Drop the change or report it with request_input." },
          summary: "retry cap reached",
        };
      }

      const result = await writeContext(client, {
        workspaceId: run.workspaceId,
        agentRunId: run.id,
        baseVersionId: run.inputs.contextVersionId,
        changes: input.changes,
        summary: input.summary,
      });

      if (result.status === "committed") {
        return {
          status: "ok",
          output: { versionId: result.versionId, versionNumber: result.versionNumber, changedPaths: result.changedPaths },
          summary: `wrote ${result.changedPaths.join(", ")}`,
        };
      }
      if (result.status === "unchanged") return { status: "ok", output: { unchanged: true }, summary: "no change" };

      const conflicts = result.conflicts.map((conflict: ContextConflict) =>
        canSeeContextPath(caller, conflict.path) ? conflict : { ...conflict, currentContent: null },
      );
      return {
        status: "conflict",
        output: {
          retryable: true,
          retriesLeft: MAX_CONFLICTED_WRITES - (count ?? 0) - 1,
          conflicts,
        },
        summary: `conflict on ${conflicts.map((conflict) => conflict.path).join(", ")}`,
      };
    },
  });

  const requestInput = defineTool({
    name: "request_input",
    description:
      "Ask a person a question you cannot answer yourself. The run does not wait: continue without the answer if you can. The answer is used later.",
    input: z.object({
      question: z.string().min(1).max(2000),
      options: z.array(z.string().min(1).max(200)).max(10).optional(),
    }),
    handler: async ({ input, caller }) => {
      const run = requireRun(caller, "request_input");
      const { data, error } = await client
        .from("agent_run_input_requests")
        .insert({ workspace_id: run.workspaceId, agent_run_id: run.id, question: input.question, options: input.options ?? null })
        .select("id")
        .single();
      if (error) throw error;
      return { status: "ok", output: { requestId: (data as { id: string }).id, status: "open" }, summary: input.question.slice(0, 200) };
    },
  });

  return [write, requestInput];
}
