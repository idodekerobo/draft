import type { ValidatedRunBundle } from "./context-version-files";
import type { DimensionHint } from "./types";

const CONTEXT_PREFIX = "input/context/";
const SOURCES_PREFIX = "input/sources/";
const OUTPUT_PATH = "output/result.json";

interface ContextFileEntry {
  logicalPath: string;
  readPath: string;
  sha256: string;
}

interface SourceFileEntry {
  fileName: string;
  readPath: string;
}

function collectContextFiles(bundle: ValidatedRunBundle): ContextFileEntry[] {
  const entries: ContextFileEntry[] = [];
  for (const [path, file] of Object.entries(bundle.files)) {
    if (!path.startsWith(CONTEXT_PREFIX)) continue;
    entries.push({
      logicalPath: path.slice(CONTEXT_PREFIX.length),
      readPath: path,
      sha256: file.sha256,
    });
  }
  entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  return entries;
}

function collectSourceFiles(bundle: ValidatedRunBundle): SourceFileEntry[] {
  const entries: SourceFileEntry[] = [];
  for (const path of Object.keys(bundle.files)) {
    if (!path.startsWith(SOURCES_PREFIX)) continue;
    entries.push({
      fileName: path.slice(SOURCES_PREFIX.length),
      readPath: path,
    });
  }
  entries.sort((a, b) => a.readPath.localeCompare(b.readPath));
  return entries;
}

// The model must see exactly ONE path per file (a bundle-relative "read
// from" path, never absolute) — a prior bug had it pick the wrong one as a
// "documents" key when both were shown.
function buildBootstrapSection(dimensions: DimensionHint[]): string {
  const dimensionList = dimensions
    .map((d) => `- ${d.dimensionName}: ${d.dimensionDescription}`)
    .join("\n");

  return `## Bootstrap guidance
This is this workspace's first synthesis run — there is no existing context yet.
The user selected these dimensions to track. Use them as guidance for what
documents to create (one Markdown file per dimension is a reasonable default,
e.g. "company/index.md"), but you still decide the actual document names and
structure — these are a starting hint, not a literal file manifest.

${dimensionList}
`;
}

function buildPrompt(
  contextFiles: ContextFileEntry[],
  sourceFiles: SourceFileEntry[],
  dimensions?: DimensionHint[],
): string {
  const contextList =
    contextFiles
      .map(
        (f) =>
          `- ${f.logicalPath}\n  read from: ${f.readPath}\n  sha256: ${f.sha256}`,
      )
      .join("\n") || "(no existing context)";
  const sourceList =
    sourceFiles.map((f) => `- read from: ${f.readPath}`).join("\n") ||
    "(no new source material)";
  const bootstrapSection =
    contextFiles.length === 0 && dimensions && dimensions.length > 0
      ? `\n${buildBootstrapSection(dimensions)}\n`
      : "";

  return `# Draft Synthesis Task

You are a context synthesis agent for Draft, a shared team context layer.

## Existing context (read-only; paths and content-hashes below are host-verified)
${contextList}
${bootstrapSection}
## New source material to reconcile against the context above
${sourceList}

Read each source file, then read the existing context files above before deciding what changes.

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

## Output contract
Write exactly one JSON document to ${OUTPUT_PATH}. No other output, no commentary.

{
  "outcome": "changed" | "no_change",
  "summary": "one-line description of what changed, or why nothing did",
  "documents": {
    "<path>": "<complete replacement Markdown content for that file>"
  },
  "needs_input": [
    {
      "question": "...",
      "current_claim": "...",
      "new_claim": "...",
      "reason": "...",
      "evidence": [{ "source_item_id": "...", "excerpt": "..." }]
    }
  ]
}

Rules:
- "documents" is required when outcome is "changed", and must be omitted (or empty) when outcome is "no_change".
- Each key in "documents" must be one of the bare paths listed under "Existing context" above (e.g. "product/index.md") -- exactly as written there, never the "read from" filesystem path, and never invented.
- Each value is the COMPLETE replacement content for that file, not a diff or patch.
- Only include a file in "documents" if it actually changed. Files you don't include are carried forward unchanged.
- "needs_input" is optional and independent of "outcome" -- a run can be "changed" and still raise a question.
- Write nothing else to disk. Do not modify the files under input/.
`;
}

function buildJsonSchema(allowedDocumentPaths: string[]): Record<string, unknown> {
  const needsInputItemSchema = {
    type: "object",
    additionalProperties: false,
    required: ["question", "current_claim", "new_claim", "reason", "evidence"],
    properties: {
      question: { type: "string" },
      current_claim: { type: "string" },
      new_claim: { type: "string" },
      reason: { type: "string" },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source_item_id", "excerpt"],
          properties: {
            source_item_id: { type: "string" },
            excerpt: { type: "string" },
          },
        },
      },
    },
  };

  // Constrain "documents" keys to the bundle's known logical paths, mirroring
  // the prompt's own rule mechanically.
  const documentsSchema =
    allowedDocumentPaths.length > 0
      ? {
          type: "object",
          propertyNames: { enum: allowedDocumentPaths },
          additionalProperties: { type: "string" },
        }
      : {
          type: "object",
          additionalProperties: { type: "string" },
        };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: ["outcome", "summary"],
    properties: {
      outcome: { type: "string", enum: ["changed", "no_change"] },
      summary: { type: "string", minLength: 1 },
      documents: documentsSchema,
      needs_input: {
        type: "array",
        items: needsInputItemSchema,
      },
    },
  };
}

export async function renderSynthesisPrompt(
  bundle: ValidatedRunBundle,
  dimensions?: DimensionHint[],
): Promise<{ prompt: string; jsonSchema: Record<string, unknown> }> {
  const contextFiles = collectContextFiles(bundle);
  const sourceFiles = collectSourceFiles(bundle);
  const prompt = buildPrompt(contextFiles, sourceFiles, dimensions);
  const jsonSchema = buildJsonSchema(contextFiles.map((f) => f.logicalPath));
  return { prompt, jsonSchema };
}
