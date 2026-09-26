import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalDocumentsHash, sha256 } from "./context-version-files";
import {
  MEMORY_INDEX_PATH,
  resolveMemoryPeriod,
  type ResolvedMemoryPeriod,
} from "./memory-period";
import type { WorkspaceContextVersionRow } from "../types/tables";

function stubContent(period: ResolvedMemoryPeriod): string {
  return `---\nperiod: ${period.kind}\nstart: ${period.start}\nend: ${period.end}\n---\n\n(no entries yet)\n`;
}

const MEMORY_INDEX_STUB = `---
name: memory
description: Workspace-wide chronological log, recomputed continuously. Not a per-person log -- entries attribute who did what inline.
---

Read a specific period with \`draft context read --dimension memory --period <today|yesterday|this-week|last-week|this-month|last-month|YYYY-MM-DD|YYYY-MM>\`.

- memory/days/<YYYY-MM-DD>.md -- one day
- memory/weeks/<monday-date>.md -- Monday-Sunday, keyed by the Monday
- memory/months/<YYYY-MM>.md -- one calendar month
`;

export interface EnsureMemoryProvisionedInput {
  client: SupabaseClient;
  workspaceId: string;
  baseVersionId: string;
  documents: WorkspaceContextVersionRow["documents_json"];
  versionNumber: number;
  timezone: string;
  now?: Date;
}

export interface EnsureMemoryProvisionedResult {
  baseContextVersionId: string;
}

/**
 * Pure: computes which memory documents (index + today/this-week/this-month)
 * are missing from `documents` and returns just those as a documents_json
 * fragment. No I/O -- callers merge the result into whatever insert/update
 * they're already doing. Exported so prepareRun can fold this into a brand
 * new workspace's seed insert instead of a separate provisioning round trip.
 */
export function computeMemoryAdditions(
  documents: WorkspaceContextVersionRow["documents_json"],
  timezone: string,
  now: Date = new Date(),
): WorkspaceContextVersionRow["documents_json"] {
  const periods = [
    resolveMemoryPeriod("today", timezone, now),
    resolveMemoryPeriod("this-week", timezone, now),
    resolveMemoryPeriod("this-month", timezone, now),
  ];

  const additions: WorkspaceContextVersionRow["documents_json"] = {};
  if (!(MEMORY_INDEX_PATH in documents)) {
    additions[MEMORY_INDEX_PATH] = {
      content: MEMORY_INDEX_STUB,
      sha256: sha256(MEMORY_INDEX_STUB),
    };
  }
  for (const period of periods) {
    if (period.path in documents) continue;
    const content = stubContent(period);
    additions[period.path] = { content, sha256: sha256(content) };
  }
  return additions;
}

/**
 * Ensures memory/index.md plus the current day/week/month document paths
 * exist in the workspace's context. This is deterministic, host-side
 * provisioning (no LLM call) -- the synthesis model is only ever allowed to
 * rewrite paths that already exist (render-prompt.ts's allowedDocumentPaths),
 * so a brand-new day file has to be stubbed in before a run can touch it.
 * A no-op (returns baseVersionId unchanged) once today/this-week/this-month
 * are already provisioned. For a fresh workspace with no version yet, prefer
 * computeMemoryAdditions() folded into the seed insert instead of calling
 * this (avoids a second insert + pointer update right after the first).
 */
export async function ensureMemoryProvisioned(
  input: EnsureMemoryProvisionedInput,
): Promise<EnsureMemoryProvisionedResult> {
  const additions = computeMemoryAdditions(input.documents, input.timezone, input.now ?? new Date());
  if (Object.keys(additions).length === 0) {
    return { baseContextVersionId: input.baseVersionId };
  }

  const documents = { ...input.documents, ...additions };
  const contentHash = canonicalDocumentsHash(documents);

  const { data, error } = await input.client
    .from("workspace_context_versions")
    .insert({
      workspace_id: input.workspaceId,
      version_number: input.versionNumber + 1,
      previous_version_id: input.baseVersionId,
      documents_json: documents,
      content_hash: contentHash,
      creation_reason: "memory_provision",
      summary: `Provisioned ${Object.keys(additions).length} memory document(s)`,
    })
    .select("id")
    .single();
  if (error) throw error;
  const newVersionId = (data as { id: string }).id;

  const { error: pointerError } = await input.client
    .from("workspaces")
    .update({ current_context_version_id: newVersionId })
    .eq("id", input.workspaceId);
  if (pointerError) throw pointerError;

  return { baseContextVersionId: newVersionId };
}
