import type { ScannedSkillEntry } from "../../../rpc/schema";

export type Agent = ScannedSkillEntry["agent"];

export const AGENT_LABELS: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function skillKey(skill: ScannedSkillEntry): string {
  return `${skill.agent}:${skill.dirPath}`;
}

export function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

export interface GroupedSkills {
  agent: Agent;
  skills: ScannedSkillEntry[];
}

export function groupByAgent(skills: ScannedSkillEntry[], query?: string): GroupedSkills[] {
  const normalizedQuery = (query ?? "").trim().toLowerCase();
  return (Object.keys(AGENT_LABELS) as Agent[]).map((agent) => ({
    agent,
    skills: skills.filter((skill) =>
      skill.agent === agent && (!normalizedQuery || skill.name.toLowerCase().includes(normalizedQuery)),
    ),
  }));
}
