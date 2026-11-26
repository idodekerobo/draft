import { checkRoutineSteps } from "draft-core/routine-steps";
import type { AgentRoutineConfig } from "./config";
import { routinePermissions } from "./run-spec";

/**
 * True when every step of the routine asks for no more than the routine may use. The check allows what the owner's
 * Gmail connection could add, because that is only known at launch; a run keeps only what the routine really has.
 */
export function stepPermissionsFit(config: AgentRoutineConfig): boolean {
  if (!config.steps) return true;
  const result = checkRoutineSteps(config.steps, { harness: config.harness, routinePermissions: routinePermissions(config, new Set(["gmail"])), allowSourceBatches: false });
  return result.ok;
}
