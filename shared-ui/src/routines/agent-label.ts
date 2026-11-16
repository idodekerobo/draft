import { effortLabel, harnessLabel, modelLabel } from "draft-core/harnesses";

/** "Claude Code · Haiku · High" for the row under a routine's name and the header of a session. */
export function agentLabel(agent: { harness: string; model: string | null; effort?: string | null }): string {
  const parts = [harnessLabel(agent.harness), modelLabel(agent.harness, agent.model)];
  if (agent.effort) parts.push(effortLabel(agent.effort));
  return parts.filter(Boolean).join(" · ");
}
