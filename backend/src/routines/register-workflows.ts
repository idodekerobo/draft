import { synthesisWorkflow } from "./built-in/synthesis/workflow";
import { routineWorkflow } from "./step-workflow";
import { registerWorkflow } from "./workflow/registry";

/** Tells the step engine how each kind of routine carries out its steps. Called once, when the server starts. */
export function registerWorkflows(): void {
  registerWorkflow(synthesisWorkflow);
  registerWorkflow(routineWorkflow);
}
