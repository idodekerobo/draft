import type { ApprovalResult } from "./types";

/** Turns the error code of a failed decision into the result the approval panel shows. */
export function toApprovalResult(code: string, byName?: string | null): Exclude<ApprovalResult, { ok: true }> {
  if (code === "already_decided") return { ok: false, error: "already_decided", byName: byName ?? null };
  if (code === "request_closed" || code === "session_ended") return { ok: false, error: code };
  return { ok: false, error: "failed" };
}
