import { harnessModeValues } from "draft-core/harnesses";

export type CodexApproval = "ask-for-approval" | "approve-for-me" | "full-access";
export type CodexCollaboration = "default" | "plan";

export const DEFAULT_APPROVAL: CodexApproval = "ask-for-approval";
export const DEFAULT_COLLABORATION: CodexCollaboration = "default";

const APPROVALS = harnessModeValues("codex", "approval");
const COLLABORATIONS = harnessModeValues("codex", "permission");
export const isApproval = (value: unknown): value is CodexApproval => typeof value === "string" && APPROVALS.includes(value);
export const isCollaboration = (value: unknown): value is CodexCollaboration => typeof value === "string" && COLLABORATIONS.includes(value);

/**
 * The turn/start settings for an approval choice. Codex keeps them for the turn and the turns after it, so they
 * are sent with every turn once someone has chosen. Before that, the thread's own settings stand.
 */
export function approvalOverrides(approval: CodexApproval): Record<string, unknown> {
  switch (approval) {
    case "ask-for-approval":
      return { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } };
    case "approve-for-me":
      return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } };
    case "full-access":
      return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  }
}

/** The thread/settings/update that sets Codex's collaboration mode. It needs the model the thread runs. */
export function collaborationUpdate(threadId: string, mode: CodexCollaboration, model: string): Record<string, unknown> {
  return { threadId, collaborationMode: { mode, settings: { model, reasoning_effort: null, developer_instructions: null } } };
}
