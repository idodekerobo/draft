import { harnessLabel, modelLabel } from "draft-core/harnesses";
import type { AgentRoutine } from "./types";

/** "Claude Code · Haiku" for the row under a routine's name. */
export function agentLabel(agent: Pick<AgentRoutine, "harness" | "model">): string {
  const model = modelLabel(agent.harness, agent.model);
  return model ? `${harnessLabel(agent.harness)} · ${model}` : harnessLabel(agent.harness);
}
