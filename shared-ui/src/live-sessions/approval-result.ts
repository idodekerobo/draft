import type { ApprovalResult } from "./types";

/** Turns the error code of a failed decision into the result the approval panel shows. */
export function toApprovalResult(code: string, byName?: string | null): Exclude<ApprovalResult, { ok: true }> {
  if (code === "already_decided") return { ok: false, error: "already_decided", byName: byName ?? null };
  if (code === "request_closed" || code === "session_ended") return { ok: false, error: code };
  return { ok: false, error: "failed" };
}

/** The line that replaces the buttons when a decision came too late. */
export function closedMessage(result: Exclude<ApprovalResult, { ok: true }>): string {
  if (result.error === "already_decided") return result.byName ? `Already decided by ${result.byName}` : "Already decided";
  if (result.error === "session_ended") return "This session has ended";
  return "This request already ended";
}
