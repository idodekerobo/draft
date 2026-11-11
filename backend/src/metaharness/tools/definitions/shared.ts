import type { ToolCaller } from "draft-core/tools";

export function callerWorkspaceId(caller: ToolCaller): string {
  return caller.type === "run" ? caller.run.workspaceId : caller.workspaceId;
}

export function requireUser(caller: ToolCaller, tool: string) {
  if (caller.type !== "user") throw new Error(`${tool} needs a signed-in person`);
  return caller;
}

export function requireRun(caller: ToolCaller, tool: string) {
  if (caller.type !== "run") throw new Error(`${tool} can only be called by an agent run`);
  return caller.run;
}
