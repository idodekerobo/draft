import { harnessLabel, modelLabel } from "draft-core/harnesses";

/** "Claude Code · Haiku" for the row under a routine's name and the header of a session. */
export function agentLabel(agent: { harness: string; model: string | null }): string {
  const model = modelLabel(agent.harness, agent.model);
  return model ? `${harnessLabel(agent.harness)} · ${model}` : harnessLabel(agent.harness);
}
