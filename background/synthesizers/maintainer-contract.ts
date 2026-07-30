import type { ContextSnapshot } from './synthesis-runtime';

export interface MaintainerContractInput {
  snapshot: ContextSnapshot;
  metadata: {
    session_id: string;
    input_source: string;
    synthesized_by: string;
    timestamp: string;
    profile: string;
  };
  outputPath: string;
}

/**
 * Render the source-agnostic contract shared by maintainer synthesizers.
 * Source adapters remain responsible for supplying the evidence to analyze.
 */
export function buildMaintainerContractPrompt(input: MaintainerContractInput): string {
  const files = input.snapshot.files.map(file =>
    `- ${file.relativePath}\n  snapshot: ${file.snapshotPath}\n  host_sha256: ${file.sha256}`,
  ).join('\n') || '(no context index snapshots supplied)';
  const tensions = input.snapshot.tensions
    ? `- ${input.snapshot.tensions.relativePath} (optional conflict evidence; read-only)\n`
      + `  snapshot: ${input.snapshot.tensions.snapshotPath}\n`
      + `  host_sha256: ${input.snapshot.tensions.sha256}`
    : '(no tensions snapshot supplied)';
  const example = input.snapshot.files[0];

  return `# Shared Draft maintainer contract

Use the source evidence supplied elsewhere in this task to maintain existing team context.

## Trusted metadata
These host-supplied values must be copied exactly into the output:
- session_id: ${input.metadata.session_id}
- input_source: ${input.metadata.input_source}
- synthesized_by: ${input.metadata.synthesized_by}
- timestamp: ${input.metadata.timestamp}
- profile: ${input.metadata.profile}
- output_path: ${input.outputPath}

## Stable context snapshot
Read only the snapshot paths below. The host SHA-256 values identify the exact input bytes:
${files}

Tensions snapshot:
${tensions}

Never write to a snapshot path or to context/tensions.md. Write exactly one result document to ${input.outputPath}.

## Judgment
- Preserve all still-valid context. Rewrite a file only when the evidence makes its durable current state clearer.
- Capture durable product, company, team, priority, or working patterns; do not restate a PR, diff, transcript, or activity feed.
- A later timestamp is not a resolution receipt. Do not treat recency alone as proof that one side of a conflict supersedes another.
- Meeting discussion is durable only when it records an attributable decision, owner, or constraint. Speculation and unattributed discussion are not context.
- Use needs_input only for a named conflict whose competing claims cannot be safely reconciled from the evidence. Name both claims and where they came from.
- An existing "Known Patterns" or similar historical list is not permission to log every implementation. A durable rule such as "all transport layers use isolated temporary clones" belongs; "PR #42 changed publish.ts and added tests" merely restates shipped work and does not.

## Output contract
Choose exactly one outcome: no_change, rewrite, or needs_input.
- no_change: omit rewrites and needs_input_reason.
- rewrite: include one or more rewrites. Each file must be a unique existing context/<dimension>/index.md target listed above. Copy that target's supplied host_sha256 exactly into base_sha256. summary and content must both be nonempty. content is the complete replacement document, not a patch. removals is optional; when present, each item has a nonempty claim and reason.
- needs_input: include a nonempty needs_input_reason and omit rewrites.

Return exactly one Markdown document with one YAML frontmatter block. Put every machine field, including rewrites or needs_input_reason when applicable, before its closing ---. Do not emit a second YAML schema in the body.

Worked no_change example: a PR renames an internal helper and updates its tests, but establishes no durable product, team, or engineering rule. Return these frontmatter fields and nothing outcome-specific:
  outcome: no_change
  session_id: ${yamlString(input.metadata.session_id)}
  input_source: ${yamlString(input.metadata.input_source)}
  synthesized_by: ${yamlString(input.metadata.synthesized_by)}
  timestamp: ${yamlString(input.metadata.timestamp)}
  profile: ${yamlString(input.metadata.profile)}

Worked needs_input example: the snapshot says "self-hosted only" while new evidence says "hosted is the default." The snapshot's later timestamp is not a receipt that this conflict was resolved. With no explicit decision or linked fix, return:
  outcome: needs_input
  session_id: ${yamlString(input.metadata.session_id)}
  input_source: ${yamlString(input.metadata.input_source)}
  synthesized_by: ${yamlString(input.metadata.synthesized_by)}
  timestamp: ${yamlString(input.metadata.timestamp)}
  profile: ${yamlString(input.metadata.profile)}
  needs_input_reason: "Product context says self-hosted only; new evidence says hosted is the default; neither source records a decision resolving the conflict."

Canonical rewrite example (replace the example summary/content with the actual complete result):
---
outcome: rewrite
session_id: ${yamlString(input.metadata.session_id)}
input_source: ${yamlString(input.metadata.input_source)}
synthesized_by: ${yamlString(input.metadata.synthesized_by)}
timestamp: ${yamlString(input.metadata.timestamp)}
profile: ${yamlString(input.metadata.profile)}
rewrites:
  - file: ${example?.relativePath ?? 'context/<existing-dimension>/index.md'}
    base_sha256: ${example?.sha256 ?? '<supplied-host-sha256>'}
    summary: Brief durable change summary
    content: |
      Complete rewritten context document.
    removals:
      - claim: Exact obsolete claim removed
        reason: Evidence that explicitly supersedes or invalidates it
---

For no_change, set outcome to no_change and omit rewrites. For needs_input, set outcome to needs_input, replace rewrites with needs_input_reason: "<named conflict and competing sources>", and keep it inside the same frontmatter. Emit no writes for tensions.`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
