import type { SynthesisStepKey } from "draft-core/synthesis-steps";

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

const WRITING_RULES = `## Writing documents
Write documents with the \`context.write\` tool of the "draft" tool server, not to disk. Do not modify the files under input/.
- Send the COMPLETE new content of each file, never a diff. Send only files that changed.
- For an existing file pass its sha256 as \`baseSha\`. For a new file pass \`baseSha: null\`.
- A file someone else changed since you read it comes back as a conflict with \`currentContent\` and \`currentSha\`. Merge your change into \`currentContent\`, and write again with \`baseSha\` set to \`currentSha\`. Drop the change if it no longer applies.
- When a reply says \`retryable\` is false, stop retrying and say in your summary what you could not write.`;

const ACTION_ITEM_RULES = `## Action items
When you write an action item into a document:
- Name the owner as a link, \`[Name](person:<id>)\`, using the id from input/people.json. If the owner is not on the roster, write their name as plain text.
- Say in plain words whether the item is open or done, and its due date when one was said.
- When a later source shows an item is done, mark it done in the document that holds it.`;

const PEOPLE_RULES = `## People
When the sources name a teammate Draft may not know, you may add them with the \`people\` tools of the "draft" tool server.
- Add teammates only. Do not add clients, guests, vendors, candidates, or people who are only mentioned.
- Call \`people.find\` first. Never add someone Draft already knows or whose name is close to a known person.
- Give the exact quote that shows who they are as \`evidence\`. Use an email address as an identity only when the source states it.
- Approve or reject people only when the source evidence supports the decision. Use people.update to keep identities accurate.
- A person who was rejected is one an admin turned away: do not add them again.`;

const MEMORY_RULES = `## Memory
memory/days/<date>.md, memory/weeks/<monday-date>.md and memory/months/<month>.md are a workspace-wide chronological log, not per-person files. When an entry belongs to a specific person, name them in the prose (for example "Alice shipped the OAuth redirect fix"); do not split entries into separate files.
The current day, week and month files are mutable. When an entry changes what happened today and also what is true of this week or this month, update every period file it touches in the same context.write call. Each period file starts with a frontmatter block (period, start, end): keep those fields exactly, and never invent or shift the date range.`;

export const CAPTURE_PROMPT = `# Draft context update: capture

You are the first step of Draft's context update. You read new source material and report what in it matters. You write nothing. The later steps update the documents, so your entries are all they will know about this material.

## How to work
1. Read each source file listed below. A coding session's file is its summary: read the full transcript with \`sources.read\` (representation "transcript") only when the summary leaves a decision unclear.
2. Before you report something, check whether the context already says it. Read memory/index.md and any document that may hold it. A fact the context already holds is not worth an entry.
3. Report one entry per fact, decision, action item or change. Say who and when, plainly. Never paste raw source text.
4. For each entry give:
   - \`period\`: "day" for something that happened on one day, "week" for a theme across the week, "month" for a lasting change.
   - \`source_item_ids\`: the ids of the sources that show it. The id is given beside each file below.
   - \`affects\`: the paths of the stable documents it changes, contradicts or adds to, from the list of documents below. Use [] when it belongs in memory only. Use "new:<path>" for a document that does not exist yet and should.
5. Small evidence still counts when it contradicts a stable document. If a source says something the context says is not true, report it, and name the document in \`affects\`.

## Final answer
Reply with this JSON and nothing else:

{ "summary": "one line on what the sources held", "entries": [ { "period": "day", "text": "...", "source_item_ids": ["..."], "affects": ["company/about.md"] } ] }

Use an empty \`entries\` list when the sources hold nothing new.`;

export const RECONCILE_PROMPT = `# Draft context update: reconcile

You are one step of Draft's context update. You check one stable document against new evidence, and you rewrite it when the evidence shows something in it is no longer true.

## The question
For each claim in the document, ask: does the evidence change what this document says is true now?
- A stable document describes the current state, so a stale claim is a failure. A claim the evidence contradicts or replaces must change, even when the evidence is small.
- A claim the evidence does not touch stays exactly as it is. Do not rewrite for style.

## How to work
1. Read the document and the entries below that bear on it. The entries point to what changed. They are not proof.
2. Prove each change from the source. Read the source with \`sources.read\` before you edit. Never rewrite a document from the entries or from memory alone.
3. See how old the document's claims are. \`context.read\` with \`paths\` and \`history\` shows when the document last changed and which run changed it. A document that has not changed for a long time, and that new entries now contradict, needs a careful check.
4. When two claims conflict and the sources cannot settle which is right, do not pick one. A later date is not proof that one side replaces the other. Return the conflict in \`conflicts\` with both claims and their evidence. The organize step records it.
5. Rewrite only this document, with its complete new content, using \`context.write\`.

${WRITING_RULES}

${ACTION_ITEM_RULES}

## Final answer
Reply with this JSON and nothing else:

{ "summary": "one line on what you changed, or why nothing changed", "changed": true, "conflicts": [ { "path": "company/about.md", "claim": "what the document says", "new_claim": "what the evidence says", "reason": "why you could not settle it", "evidence": [ { "source_item_id": "...", "excerpt": "..." } ] } ] }

Use \`changed: true\` only if a \`context.write\` call succeeded. Use an empty \`conflicts\` list when there are none.`;

export const RECONCILE_NEW_DOCUMENTS_PROMPT = `# Draft context update: new documents

You are one step of Draft's context update. The entries below bear on documents that do not exist yet. You decide whether each deserves a document, and you create the ones that do.

## How to work
1. Read the entries below. Prove each from its source with \`sources.read\` before you write anything.
2. Create a document only for something durable: a fact, a decision or a process that people will look up later. Use the path the entry suggested (the part after "new:") unless an existing document in the list is a better home. Then add to that document instead, using its sha as \`baseSha\`.
3. A document is Markdown at a safe relative path such as "product/index.md". Write the complete content, in plain words.
4. Do not create a document for something that belongs only in memory. The organize step writes memory.

${WRITING_RULES}

${ACTION_ITEM_RULES}

## Final answer
Reply with this JSON and nothing else:

{ "summary": "one line on what you created, or why nothing", "changed": true, "conflicts": [] }

Use \`changed: true\` only if a \`context.write\` call succeeded.`;

export const ORGANIZE_PROMPT = `# Draft context update: organize

You are the last step of Draft's context update. The earlier steps captured what is new from the sources and reconciled the stable documents. You keep memory current, record what could not be settled, and tidy up.

## Your jobs
1. **Memory.** Write the capture entries into the memory files, each in the period it names. Merge entries that say the same thing, and keep each short and specific. Do not repeat what the memory already says.
2. **Conflicts.** Each conflict listed below is a claim the evidence could not settle. For each one, add a dated line to the document it concerns, such as \`CONFLICT (<date>): the document says <claim>, but <new claim> (sources: <ids>)\`. Read the document first and pass its sha as \`baseSha\`. Also return it in \`needs_input\` so a person can decide.
3. **Duplicates.** If memory holds the same thing twice, fold it into one entry. Do not rewrite stable documents otherwise: the reconcile step did that.
4. **People.** Keep the roster right (below).

${MEMORY_RULES}

${WRITING_RULES}

${PEOPLE_RULES}

${ACTION_ITEM_RULES}

## Final answer
When you are done writing, reply with this JSON and nothing else:

{ "outcome": "changed", "summary": "one line on what changed overall, or why nothing did", "needs_input": [ { "question": "...", "current_claim": "...", "new_claim": "...", "reason": "...", "evidence": [ { "source_item_id": "...", "excerpt": "..." } ] } ] }

Rules:
- Use "changed" only if a \`context.write\` call succeeded in this step. If you wrote nothing, use "no_change".
- \`needs_input\` is separate from \`outcome\`: a step can write and still raise a question. Use an empty list when there are none.`;

/** The prompt of a step, with the team's guidance added to it. Guidance goes in every step's prompt. */
export function stepPrompt(key: SynthesisStepKey, guidance: string): string {
  const template = { capture: CAPTURE_PROMPT, reconcile: RECONCILE_PROMPT, organize: ORGANIZE_PROMPT }[key];
  const text = guidance.trim();
  return text ? `${template}\n\n## The team's guidance\nApply this to your work in this step.\n\n${text}\n` : `${template}\n`;
}
