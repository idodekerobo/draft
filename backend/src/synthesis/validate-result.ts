import type { SupabaseClient } from "@supabase/supabase-js";
import type { SynthesisRunRow, WorkspaceContextVersionRow } from "../types/tables";
import type { SynthesisResultPayload, ValidatedSynthesisResult } from "./types";

// Duplicated from context-version-files.ts's assertSafeDocumentPath (not
// exported there) — kept byte-identical so the two checks can't drift apart.
const MARKDOWN_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

const MAX_DOCUMENT_CHARS = 200_000;

function assertSafeDocumentPath(path: string): void {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    !path.endsWith(".md") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !MARKDOWN_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`document path must be a safe relative Markdown path: ${path}`);
  }
}

function assertValidUtf8(content: string, label: string): void {
  const bytes = new TextEncoder().encode(content);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (decoded !== content) {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

interface ParsedResult {
  outcome: "changed" | "no_change";
  summary: string;
  documents?: Record<string, string>;
  needs_input?: SynthesisResultPayload["needs_input"];
}

// Check 1: output parses as the expected result shape.
function parseResultShape(rawResult: unknown): ParsedResult {
  if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) {
    throw new Error("synthesis result must be a JSON object");
  }
  const obj = rawResult as Record<string, unknown>;

  // Check 5: outcome is an allowed value.
  if (obj.outcome !== "changed" && obj.outcome !== "no_change") {
    throw new Error(`invalid outcome: ${String(obj.outcome)}`);
  }
  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    throw new Error("summary must be a nonempty string");
  }

  let documents: Record<string, string> | undefined;
  if (obj.outcome === "changed") {
    if (typeof obj.documents !== "object" || obj.documents === null || Array.isArray(obj.documents)) {
      throw new Error("changed outcome requires a documents object");
    }
    documents = {};
    for (const [path, content] of Object.entries(obj.documents as Record<string, unknown>)) {
      if (typeof content !== "string") {
        throw new Error(`document content must be a string: ${path}`);
      }
      documents[path] = content;
    }
  } else if (obj.documents !== undefined) {
    if (
      typeof obj.documents !== "object" ||
      obj.documents === null ||
      Array.isArray(obj.documents) ||
      Object.keys(obj.documents as Record<string, unknown>).length > 0
    ) {
      throw new Error("no_change outcome must omit documents (or leave it empty)");
    }
  }

  let needsInput: SynthesisResultPayload["needs_input"];
  if (obj.needs_input !== undefined) {
    if (!Array.isArray(obj.needs_input)) {
      throw new Error("needs_input must be an array");
    }
    needsInput = obj.needs_input as SynthesisResultPayload["needs_input"];
  }

  return {
    outcome: obj.outcome,
    summary: obj.summary,
    documents,
    needs_input: needsInput,
  };
}

// bundleHash is a placeholder here — this function has no bundle to hash.
// The caller (completeSynthesisRunCallback) overwrites it with the real
// value from the authenticated callback request.
export async function validateSynthesisResult(
  runId: string,
  rawResult: unknown,
  client?: SupabaseClient,
): Promise<ValidatedSynthesisResult> {
  const parsed = parseResultShape(rawResult);

  const db = client ?? (await import("../db/client")).serviceClient;

  const { data: runData, error: runError } = await db
    .from("synthesis_runs")
    .select("id, base_context_version_id")
    .eq("id", runId)
    .single();
  if (runError) throw runError;
  const run = runData as Pick<SynthesisRunRow, "id" | "base_context_version_id">;

  const { data: baseVersionData, error: baseVersionError } = await db
    .from("workspace_context_versions")
    .select("documents_json")
    .eq("id", run.base_context_version_id)
    .single();
  if (baseVersionError) throw baseVersionError;
  const baseDocuments = (baseVersionData as Pick<WorkspaceContextVersionRow, "documents_json">)
    .documents_json;
  const allowedPaths = new Set(Object.keys(baseDocuments));

  if (parsed.outcome === "changed") {
    const documents = parsed.documents ?? {};

    for (const [path, content] of Object.entries(documents)) {
      // Check 2: every document path must be one of the base version's real
      // document keys, fetched fresh from Postgres (not a hardcoded list).
      if (!allowedPaths.has(path)) {
        throw new Error(`document path not in allowlist: ${path}`);
      }

      // Check 3: no "..", no absolute paths, no symlink-like segments.
      if (path.includes("..") || path.startsWith("/")) {
        throw new Error(`unsafe document path: ${path}`);
      }
      assertSafeDocumentPath(path);

      // Check 4: valid UTF-8 and under the size cap.
      assertValidUtf8(content, `document ${path}`);
      if (content.length > MAX_DOCUMENT_CHARS) {
        throw new Error(`document exceeds size cap: ${path}`);
      }
    }

    // Check 6: outcome=changed must actually differ from the base version's
    // documents_json, fetched fresh from Postgres above — never trusted from
    // the callback payload or any run-directory state. Added after a real
    // production run claimed changes it never made; the five structural
    // checks above all pass on a "changed" result whose content is
    // byte-identical to the base.
    const actuallyChanged = Object.entries(documents).some(
      ([path, content]) => baseDocuments[path]?.content !== content,
    );
    if (!actuallyChanged) {
      throw new Error(
        "outcome=changed but no document content actually differs from the base version",
      );
    }
  }

  const payload: SynthesisResultPayload = {
    outcome: parsed.outcome,
    summary: parsed.summary,
    documents: parsed.documents ?? {},
    needs_input: parsed.needs_input,
  };

  return {
    runId,
    // Placeholder — see the function-level comment above. The caller
    // (completeSynthesisRunCallback) overwrites this with the real value.
    bundleHash: "",
    payload,
  };
}
