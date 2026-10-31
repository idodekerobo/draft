// Mirrors backend/src/waitlist/questions.ts. Keep the codes identical.
// Labels also have to match the options of the Cal booking questions of the same name.
export const PROFILE_VERSION = "2";

export interface Option {
  code: string;
  label: string;
}

export const ROLE_OPTIONS: Option[] = [
  { code: "founder", label: "Founder" },
  { code: "executive", label: "Executive" },
  { code: "engineering", label: "Engineering" },
  { code: "operations", label: "Operations" },
  { code: "marketing", label: "Marketing" },
  { code: "product", label: "Product" },
  { code: "other", label: "Other" },
];

export const TEAM_SIZE_OPTIONS: Option[] = [
  { code: "solo", label: "Just me" },
  { code: "2_10", label: "2-10" },
  { code: "11_50", label: "11-50" },
  { code: "51_100", label: "51-100" },
  { code: "101_200", label: "101-200" },
  { code: "200_plus", label: "200+" },
];

export const AI_TOOL_OPTIONS: Option[] = [
  { code: "claude", label: "Claude" },
  { code: "chatgpt", label: "ChatGPT" },
  { code: "coding_agents", label: "Coding Agents" },
  { code: "cursor", label: "Cursor" },
  { code: "copilot", label: "Copilot" },
  { code: "other", label: "Other" },
  { code: "none", label: "None yet" },
];

export interface ProfileAnswers {
  name?: string;
  role?: string;
  team_size?: string;
  ai_tools?: string[];
  use_case?: string;
  how_heard?: string;
}

function labelFor(options: Option[], code: string): string | undefined {
  return options.find((option) => option.code === code)?.label;
}

// Cal prefills select questions by option label and uses the question identifier as the key.
export function profileToCalPrefill(profile: ProfileAnswers): Record<string, string | string[]> {
  const prefill: Record<string, string | string[]> = {};
  if (profile.name) prefill.name = profile.name;
  const role = profile.role && labelFor(ROLE_OPTIONS, profile.role);
  if (role) prefill.role = role;
  const teamSize = profile.team_size && labelFor(TEAM_SIZE_OPTIONS, profile.team_size);
  if (teamSize) prefill.team_size = teamSize;
  const tools = (profile.ai_tools ?? []).map((code) => labelFor(AI_TOOL_OPTIONS, code)).filter((label): label is string => !!label);
  if (tools.length > 0) prefill.ai_tools = tools;
  if (profile.use_case) prefill.use_case = profile.use_case;
  if (profile.how_heard) prefill.how_heard = profile.how_heard;
  return prefill;
}
