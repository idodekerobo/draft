import { DEFAULT_SYNTHESIS_GUIDANCE } from "../synthesis/steps/prompts";

/** The synthesis routine's guidance. It is added to the prompt of every step of a context update. */
export const DEFAULT_SYNTHESIS_PROMPT = DEFAULT_SYNTHESIS_GUIDANCE;

export const DEFAULT_SUMMARIZATION_PROMPT = `## Judgment
- Identify who was working (from the transcript content, not metadata) and on what project.
- Describe the outcome plainly: what shipped, what was left unresolved, what broke.
- List only decisions with real consequence -- architecture choices, scope cuts, direction changes. Skip routine implementation steps.
- Do not invent information not present in the transcript.
`;
