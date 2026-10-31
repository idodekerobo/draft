// Mirrors apps/landing-page/lib/waitlist-questions.ts. Keep the codes and labels identical.
// Labels are also the option text of the Cal booking questions, which is what Cal sends back.
export const PROFILE_VERSION = "2";

export const ROLE_CODES = ["founder", "executive", "engineering", "operations", "marketing", "product", "other"] as const;
export const TEAM_SIZE_CODES = ["solo", "2_10", "11_50", "51_100", "101_200", "200_plus"] as const;
export const AI_TOOL_CODES = ["claude", "chatgpt", "coding_agents", "cursor", "copilot", "other", "none"] as const;

export const ROLE_LABELS: Record<(typeof ROLE_CODES)[number], string> = {
  founder: "Founder",
  executive: "Executive",
  engineering: "Engineering",
  operations: "Operations",
  marketing: "Marketing",
  product: "Product",
  other: "Other",
};

export const TEAM_SIZE_LABELS: Record<(typeof TEAM_SIZE_CODES)[number], string> = {
  solo: "Just me",
  "2_10": "2-10",
  "11_50": "11-50",
  "51_100": "51-100",
  "101_200": "101-200",
  "200_plus": "200+",
};

export const AI_TOOL_LABELS: Record<(typeof AI_TOOL_CODES)[number], string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  coding_agents: "Coding Agents",
  cursor: "Cursor",
  copilot: "Copilot",
  other: "Other",
  none: "None yet",
};
