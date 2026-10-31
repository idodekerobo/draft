import { cleanProfile } from "./profile";
import { AI_TOOL_LABELS, PROFILE_VERSION, ROLE_LABELS, TEAM_SIZE_LABELS } from "./questions";

export interface CalAnswers {
  name?: string;
  role?: string;
  team_size?: string;
  ai_tools?: string | string[];
  use_case?: string;
  how_heard?: string;
}

function codeForLabel(labels: Record<string, string>, label: string | undefined): string | undefined {
  const wanted = label?.trim().toLowerCase();
  if (!wanted) return undefined;
  return Object.entries(labels).find(([, text]) => text.toLowerCase() === wanted)?.[0];
}

// Cal sends the label of the chosen option. Unknown labels are dropped by cleanProfile.
export function calAnswersToProfile(answers: CalAnswers): Record<string, string> {
  const tools = Array.isArray(answers.ai_tools) ? answers.ai_tools : answers.ai_tools ? [answers.ai_tools] : [];
  return cleanProfile({
    profile_version: PROFILE_VERSION,
    name: answers.name,
    role: codeForLabel(ROLE_LABELS, answers.role),
    team_size: codeForLabel(TEAM_SIZE_LABELS, answers.team_size),
    ai_tools: tools.map((tool) => codeForLabel(AI_TOOL_LABELS, tool)),
    use_case: answers.use_case,
    how_heard: answers.how_heard,
  });
}
