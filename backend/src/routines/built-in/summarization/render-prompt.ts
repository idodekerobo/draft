import { DEFAULT_SUMMARIZATION_PROMPT } from "../../built-in-defaults";
const OUTPUT_PATH = "output/result.json";

export function buildSummarizationPrompt(transcript: string, instructions = DEFAULT_SUMMARIZATION_PROMPT): string {
  return `# Draft Session Summarization Task

You are summarizing one coding agent session transcript for Draft, a shared
team context layer. The transcript is inlined below; use it as the source for this summary.

## Transcript
${transcript}

${instructions}
## Output contract
Return exactly one JSON document as your final response. Draft saves it to ${OUTPUT_PATH}. No commentary.

{
  "who": "who was working in this session, as best identified from the transcript",
  "project": "the project or codebase this session touched",
  "outcome": "one-paragraph plain description of what happened and where it landed",
  "keyDecisions": ["consequential decision 1", "consequential decision 2"]
}

Rules:
- "keyDecisions" may be empty if the session made no consequential decisions.
- Do not write files; return the JSON directly.
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
