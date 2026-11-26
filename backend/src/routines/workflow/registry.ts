import type { StepParentKind } from "draft-core/run-spec";
import type { WorkflowKind } from "./types";

const workflows = new Map<StepParentKind, WorkflowKind>();

/** Says how routines of one kind carry out their steps. Done once, at startup, by `register-workflows.ts`. */
export function registerWorkflow(workflow: WorkflowKind): void {
  workflows.set(workflow.kind, workflow);
}

export function workflowFor(kind: StepParentKind): WorkflowKind {
  const workflow = workflows.get(kind);
  if (!workflow) throw new Error(`No step workflow is registered for ${kind} runs`);
  return workflow;
}

/** For tests. */
export function clearWorkflows(): void {
  workflows.clear();
}
