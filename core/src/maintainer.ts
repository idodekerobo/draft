import { JSON_SCHEMA, load } from "js-yaml";

const MAX_OUTPUT_BYTES = 1_000_000;
const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "outcome",
  "rewrites",
  "needs_input_reason",
  "session_id",
  "input_source",
  "synthesized_by",
  "timestamp",
  "profile",
  "meeting_ids",
]);
const ALLOWED_REWRITE_FIELDS = new Set([
  "file",
  "base_sha256",
  "summary",
  "content",
  "removals",
]);
const ALLOWED_REMOVAL_FIELDS = new Set(["claim", "reason"]);

export interface MaintainerMetadata {
  session_id?: string;
  input_source?: string;
  synthesized_by?: string;
  timestamp?: string;
  profile?: string;
  meeting_ids?: string[];
}

export interface MaintainerRemoval {
  claim: string;
  reason: string;
}

export interface MaintainerRewrite {
  file: string;
  base_sha256: string;
  summary: string;
  content: string;
  removals?: MaintainerRemoval[];
}

export type MaintainerOutput =
  | (MaintainerMetadata & {
      outcome: "no_change";
    })
  | (MaintainerMetadata & {
      outcome: "rewrite";
      rewrites: MaintainerRewrite[];
    })
  | (MaintainerMetadata & {
      outcome: "needs_input";
      needs_input_reason: string;
    });

export type MaintainerOutputValidation =
  | { ok: true; output: MaintainerOutput }
  | { ok: false; error: string };

/**
 * Parse and validate untrusted maintainer output. Only values inside the first,
 * opening YAML frontmatter block are considered part of the contract.
 */
export function validateMaintainerOutput(raw: string): MaintainerOutputValidation {
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) {
    return failure("maintainer output exceeds 1 MB");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) {
    return failure("maintainer output contains control characters");
  }

  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    return failure("missing YAML frontmatter");
  }

  let parsed: unknown;
  try {
    parsed = load(frontmatter[1] ?? "", { schema: JSON_SCHEMA });
  } catch {
    return failure("malformed YAML frontmatter");
  }
  if (!isRecord(parsed)) {
    return failure("frontmatter must be an object");
  }

  const unknownTopLevelField = firstUnknownField(parsed, ALLOWED_TOP_LEVEL_FIELDS);
  if (unknownTopLevelField) {
    return failure(`unknown top-level field ${JSON.stringify(unknownTopLevelField)}`);
  }

  const metadata = validateMetadata(parsed);
  if (!metadata.ok) return metadata;

  if (typeof parsed.outcome !== "string") {
    return failure("outcome must be a string");
  }

  switch (parsed.outcome) {
    case "no_change":
      if (has(parsed, "rewrites")) {
        return failure("no_change outcome forbids rewrites");
      }
      if (has(parsed, "needs_input_reason")) {
        return failure("no_change outcome forbids needs_input_reason");
      }
      return {
        ok: true,
        output: { outcome: "no_change", ...metadata.value },
      };

    case "needs_input":
      if (has(parsed, "rewrites")) {
        return failure("needs_input outcome forbids rewrites");
      }
      if (!has(parsed, "needs_input_reason") || !isNonemptyString(parsed.needs_input_reason)) {
        return failure("needs_input_reason must be a nonempty string");
      }
      return {
        ok: true,
        output: {
          outcome: "needs_input",
          needs_input_reason: parsed.needs_input_reason,
          ...metadata.value,
        },
      };

    case "rewrite": {
      if (has(parsed, "needs_input_reason")) {
        return failure("rewrite outcome forbids needs_input_reason");
      }
      if (!Array.isArray(parsed.rewrites) || parsed.rewrites.length === 0) {
        return failure("rewrites must be a nonempty array");
      }

      const rewrites: MaintainerRewrite[] = [];
      const targets = new Set<string>();
      for (const [index, candidate] of parsed.rewrites.entries()) {
        const rewrite = validateRewrite(candidate, index);
        if (!rewrite.ok) return rewrite;
        if (targets.has(rewrite.value.file)) {
          return failure(`rewrites[${index}].file duplicates target ${JSON.stringify(rewrite.value.file)}`);
        }
        targets.add(rewrite.value.file);
        rewrites.push(rewrite.value);
      }
      return {
        ok: true,
        output: { outcome: "rewrite", rewrites, ...metadata.value },
      };
    }

    default:
      return failure(`unknown outcome ${JSON.stringify(parsed.outcome)}`);
  }
}

type Success<T> = { ok: true; value: T };
type Failure = { ok: false; error: string };

function validateMetadata(record: Record<string, unknown>): Success<MaintainerMetadata> | Failure {
  const metadata: MaintainerMetadata = {};
  for (const field of ["session_id", "input_source", "synthesized_by", "timestamp", "profile"] as const) {
    if (!has(record, field)) continue;
    if (typeof record[field] !== "string") {
      return failure(`${field} must be a string`);
    }
    metadata[field] = record[field];
  }
  if (has(record, "meeting_ids")) {
    if (!Array.isArray(record.meeting_ids)) {
      return failure("meeting_ids must be an array");
    }
    for (const [index, value] of record.meeting_ids.entries()) {
      if (!isNonemptyString(value)) {
        return failure(`meeting_ids[${index}] must be a nonempty string`);
      }
    }
    metadata.meeting_ids = record.meeting_ids as string[];
  }
  return { ok: true, value: metadata };
}

function validateRewrite(candidate: unknown, index: number): Success<MaintainerRewrite> | Failure {
  const prefix = `rewrites[${index}]`;
  if (!isRecord(candidate)) {
    return failure(`${prefix} must be an object`);
  }

  const unknownField = firstUnknownField(candidate, ALLOWED_REWRITE_FIELDS);
  if (unknownField) {
    return failure(`${prefix} has unknown field ${JSON.stringify(unknownField)}`);
  }
  if (!isNonemptyString(candidate.file)) {
    return failure(`${prefix}.file must be a nonempty string`);
  }
  if (!isSafeContextIndexPath(candidate.file)) {
    return failure(`${prefix}.file is not an allowed context index path`);
  }
  if (typeof candidate.base_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(candidate.base_sha256)) {
    return failure(`${prefix}.base_sha256 must be exactly 64 lowercase hexadecimal characters`);
  }
  if (!isNonemptyString(candidate.summary)) {
    return failure(`${prefix}.summary must be a nonempty string`);
  }
  if (!isNonemptyString(candidate.content)) {
    return failure(`${prefix}.content must be a nonempty string`);
  }

  let removals: MaintainerRemoval[] | undefined;
  if (has(candidate, "removals")) {
    if (!Array.isArray(candidate.removals)) {
      return failure(`${prefix}.removals must be an array`);
    }
    removals = [];
    for (const [removalIndex, value] of candidate.removals.entries()) {
      const removalPrefix = `${prefix}.removals[${removalIndex}]`;
      if (!isRecord(value)) {
        return failure(`${removalPrefix} must be an object`);
      }
      const unknownField = firstUnknownField(value, ALLOWED_REMOVAL_FIELDS);
      if (unknownField) {
        return failure(`${removalPrefix} has unknown field ${JSON.stringify(unknownField)}`);
      }
      if (!isNonemptyString(value.claim)) {
        return failure(`${removalPrefix}.claim must be a nonempty string`);
      }
      if (!isNonemptyString(value.reason)) {
        return failure(`${removalPrefix}.reason must be a nonempty string`);
      }
      removals.push({ claim: value.claim, reason: value.reason });
    }
  }

  return {
    ok: true,
    value: {
      file: candidate.file,
      base_sha256: candidate.base_sha256,
      summary: candidate.summary,
      content: candidate.content,
      ...(removals === undefined ? {} : { removals }),
    },
  };
}

function isSafeContextIndexPath(file: string): boolean {
  if (
    /\p{Cc}/u.test(file) ||
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").includes("..")
  ) {
    return false;
  }
  return /^context\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/index\.md$/.test(file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstUnknownField(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(record).find((field) => !allowed.has(field));
}

function has(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function failure(error: string): Failure {
  return { ok: false, error };
}
