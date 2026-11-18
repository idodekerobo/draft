import type { ToolCaller } from "draft-core/tools";

export function callerWorkspaceId(caller: ToolCaller): string {
  return caller.workspaceId;
}

export function requireUser(caller: ToolCaller, tool: string) {
  const { origin } = caller;
  if (origin.kind !== "person") throw new Error(`${tool} needs a signed-in person`);
  return { workspaceId: caller.workspaceId, userId: origin.userId, via: origin.via };
}

export function requireRun(caller: ToolCaller, tool: string) {
  const { origin } = caller;
  if (origin.kind !== "run") throw new Error(`${tool} can only be called by an agent run`);
  return origin.run;
}
