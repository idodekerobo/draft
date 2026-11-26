/** What the context-update routine's Guidance field starts as. The team can change it. */
export const DEFAULT_SYNTHESIS_GUIDANCE = `**What matters:**
- Product or architecture decisions made
- Action items with clear owners
- Direction changes, new constraints, or validated or invalidated assumptions
- Team-relevant facts about users, customers, competitors, or the market

**What does not:**
- Small talk, scheduling, logistics
- Speculative ideas with no decision or action
- Implementation minutiae

**Specificity:** "Decided to drop X in favor of Y after confirming Z" matters. "Discussed some options" does not.
Do not invent information that is not in the source material. Write synthesized insight, not copied source text.
`;

/**
 * The prompt every workspace was given before context updates had steps. It told one agent to preserve
 * everything still valid. A workspace that kept it gets the new default guidance instead.
 * TODO: remove with the workspaces' stored copies once none remain.
 */
export const LEGACY_SYNTHESIS_PROMPT = `Read each source file, then read the existing context files above before deciding what changes.

**SIGNAL -- capture:**
- Product or architecture decisions made
- Action items with clear owners
- Direction changes, new constraints, or validated/invalidated assumptions
- Team-relevant facts about users, customers, competitors, or the market

**NOISE -- skip:**
- Small talk, scheduling, logistics
- Anything already captured in the existing context files
- Speculative ideas with no decision or action
- Implementation minutiae

**Specificity rule:** "Decided to drop X in favor of Y after confirming Z" is SIGNAL.
"Discussed some options" is NOISE.

## Judgment
- Preserve all still-valid context. Rewrite a file only when the evidence makes its durable current state clearer.
- A later timestamp is not a resolution receipt. Do not treat recency alone as proof one side of a conflict supersedes another.
- Use needs_input only for a named conflict whose competing claims cannot be safely reconciled from the evidence. Name both claims and their sources.
- Do not invent information not present in the source material.
- Do not copy raw source text verbatim into context; write synthesized insights.
`;

/** The team's guidance to use: the stored text, unless it is the old prompt or empty. */
export function guidanceOf(stored: string): string {
  const text = stored.trim();
  return text === "" || text === LEGACY_SYNTHESIS_PROMPT.trim() ? DEFAULT_SYNTHESIS_GUIDANCE : stored;
}
