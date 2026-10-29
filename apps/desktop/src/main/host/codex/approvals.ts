export const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";

/** What the shared approval broker shows for a Codex approval request, or null for a request that is not one. */
export function approvalPayload(method: string, params: unknown): { tool_name: string; tool_input: unknown } | null {
  const p = (params ?? {}) as { command?: string | null; cwd?: string | null; reason?: string | null; grantRoot?: string | null };
  if (method === COMMAND_APPROVAL) return { tool_name: "command", tool_input: { command: p.command ?? null, cwd: p.cwd ?? null, reason: p.reason ?? null } };
  if (method === FILE_CHANGE_APPROVAL) return { tool_name: "file_change", tool_input: { reason: p.reason ?? null, grantRoot: p.grantRoot ?? null } };
  return null;
}

/** The answer Codex waits for. No answer from a person means the request ended without one, so the step is cancelled. */
export function approvalDecision(answer: { behavior: "allow" } | { behavior: "deny" } | null): "accept" | "decline" | "cancel" {
  if (!answer) return "cancel";
  return answer.behavior === "allow" ? "accept" : "decline";
}
