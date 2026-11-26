import { z } from "zod";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import { ownerRunCaller, toolNeedsApproval } from "draft-core/tools";
import type { EmbeddedAgentContext } from "../embedded-agent/adapter";
import type { Gate } from "../embedded-agent/pi/ask-tool";
import type { InvokeToolDeps, InvokeToolResult } from "../metaharness/tools/invoke-tool";
import { invokeTool } from "../metaharness/tools/invoke-tool";
import type { RegisteredTool } from "../metaharness/tools/tool-registry";
import { parseUserId } from "draft-core/run-spec";

const MAX_OUTPUT_CHARS = 20_000;
const piName = (name: string) => name.replace(/\./g, "_");

const asText = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[cut: ${text.length - MAX_OUTPUT_CHARS} more characters]` : text;
};

/** What the model is told about a tool's result. A refusal is a result the model can act on, not a failure of Home. */
export function resultText(result: InvokeToolResult): { text: string; isError: boolean } {
  switch (result.status) {
    case "ok":
      return { text: asText(result.output), isError: false };
    case "conflict":
      return { text: `Conflict: change the request and try again. ${asText(result.output)}`, isError: true };
    case "refused":
      return { text: `Refused (${result.code}): ${result.message}`, isError: true };
    case "denied":
      return { text: `Not allowed (${result.code}): ${result.message}`, isError: true };
    case "invalid":
      return { text: `Invalid input: ${result.issues.join("; ")}`, isError: true };
    case "error":
      return { text: result.message, isError: true };
  }
}

/**
 * Draft's tools as pi tools, for Home. Each call goes through the shared tool contract in this process, as the owner and
 * through Home's run, so access, limits, audit and attribution are the same as anywhere else. A tool that grants or removes
 * access, or removes something, shows an approval card first and runs only after the person allows it. A read-only tool and
 * `people.notify` are safe to run again after a crash (notify carries a key made from the call, so a rerun sends nothing new).
 * Every other tool is not: a crash during it reports uncertainty and is never replayed.
 */
export function createHomeTools(input: { tools: ReadonlyArray<RegisteredTool>; invoke: InvokeToolDeps; context: EmbeddedAgentContext; gate: Gate }): ToolRegistration[] {
  const { invoke, context, gate } = input;
  return input.tools
    .filter((tool) => tool.modelVisible && tool.allowedOrigins.includes("person"))
    .map((tool) => {
      const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
      const approval = toolNeedsApproval(tool.name) || tool.destructive;
      return defineTool({
        name: piName(tool.name),
        description: tool.description,
        parameters: parameters as never,
        ...(tool.access === "read" || tool.name === "people.notify" ? { replay: "safe" as const } : {}),
        async execute(args, api, callContext) {
          let approvedBy;
          if (approval) {
            const card = await gate(api, callContext, { requestKind: "approval", name: tool.name, input: args });
            if (card.state === "park") return card.park;
            if (card.state === "expired") return { output: [{ type: "text", text: "No approval came, so nothing was done." }], isError: true };
            if (card.decision !== "allow") return { output: [{ type: "text", text: "The person did not approve this, so nothing was done." }], isError: true };
            approvedBy = parseUserId(context.ownerUserId);
          }
          context.assertOwner();
          const run = await context.currentRun();
          const call = tool.name === "people.notify" && typeof args === "object" && args !== null && !("idempotencyKey" in args) ? { ...(args as object), idempotencyKey: `home:${api.callId}` } : args;
          const { text, isError } = resultText(await invokeTool(invoke, ownerRunCaller(run, "app", approvedBy), tool.name, call));
          return { output: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
        },
      }) as ToolRegistration;
    });
}
