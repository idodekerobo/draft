const OUTPUT_PATH = "output/result.json";

export function buildSummarizationPrompt(transcript: string): string {
  return `# Draft Session Summarization Task

You are summarizing one coding agent session transcript for Draft, a shared
team context layer. The transcript is inlined below -- you have no filesystem
access and do not need any.

## Transcript
${transcript}

## Judgment
- Identify who was working (from the transcript content, not metadata) and on what project.
- Describe the outcome plainly: what shipped, what was left unresolved, what broke.
- List only decisions with real consequence -- architecture choices, scope cuts, direction changes. Skip routine implementation steps.
- Do not invent information not present in the transcript.

## Output contract
Write exactly one JSON document to ${OUTPUT_PATH}. No other output, no commentary.

{
  "who": "who was working in this session, as best identified from the transcript",
  "project": "the project or codebase this session touched",
  "outcome": "one-paragraph plain description of what happened and where it landed",
  "keyDecisions": ["consequential decision 1", "consequential decision 2"]
}

Rules:
- "keyDecisions" may be empty if the session made no consequential decisions.
- Write nothing else to disk.
`;
}

export function summarizationJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: ["who", "project", "outcome", "keyDecisions"],
    properties: {
      who: { type: "string", minLength: 1 },
      project: { type: "string", minLength: 1 },
      outcome: { type: "string", minLength: 1 },
      keyDecisions: { type: "array", items: { type: "string" } },
    },
  };
}
