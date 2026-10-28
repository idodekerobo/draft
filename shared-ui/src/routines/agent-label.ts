import { LIVE_SESSION_HARNESSES, LIVE_SESSION_MODELS } from "draft-core/live-sessions";
import type { AgentRoutine } from "./types";

/** "Claude Code · Haiku" for the row under a routine's name. */
export function agentLabel(agent: Pick<AgentRoutine, "harness" | "model">): string {
  const harness = LIVE_SESSION_HARNESSES.find((option) => option.id === agent.harness)?.label ?? agent.harness;
  const model = LIVE_SESSION_MODELS.find((option) => option.alias === agent.model)?.label;
  return model ? `${harness} · ${model}` : harness;
}
