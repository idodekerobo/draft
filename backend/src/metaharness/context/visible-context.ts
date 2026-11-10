import type { ToolCaller, WorkspaceId } from "draft-core/agent-run";

/** Who is reading context. `system` is Draft's own code, such as the synthesis bundle builder. */
export type ContextAudience = ToolCaller | { type: "system"; workspaceId: WorkspaceId };

/**
 * The one rule for which context documents an audience may see. Bundle builders and
 * the context.read tool both call it, so a later privacy rule changes in one place.
 * Today every audience in the workspace sees every document.
 */
export function visibleContext<T>(_audience: ContextAudience, documents: Record<string, T>): Record<string, T> {
  return documents;
}

export function canSeeContextPath(audience: ContextAudience, path: string): boolean {
  return path in visibleContext(audience, { [path]: true });
}
