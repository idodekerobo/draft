/** The new Claude session id when a SessionStart hook says the pane now holds another conversation, else null. */
export function rotationTarget(currentNativeSessionId: string, payload: Record<string, unknown>): string | null {
  const id = payload.session_id;
  if (typeof id !== "string" || id === currentNativeSessionId) return null;
  return payload.source === "compact" ? null : id;
}
