import type { SupabaseClient } from "@supabase/supabase-js";
import { commitContextVersion, loadCurrentContext } from "../agent-runs/context-store";
import { sha256 } from "./context-version-files";
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

const MAX_STALE_RETRIES = 3;

/**
 * Gives a workspace with no context its first version, with memory's stubs already in it.
 * If another writer created the first version meanwhile, that one is used.
 */
export async function seedEmptyWorkspace(
  client: SupabaseClient,
  workspaceId: string,
  timezone: string,
  now?: Date,
): Promise<string> {
  const seeded = await commitContextVersion(client, {
    workspaceId,
    expectedVersionId: null,
    documents: computeMemoryAdditions({}, timezone, now),
    reason: "seed",
    summary: "Empty workspace — no context yet",
  });
  if (seeded.status === "committed") return seeded.versionId;
  const current = await loadCurrentContext(client, workspaceId);
  if (!current.versionId) throw new Error("Workspace has no context version after seeding");
  return current.versionId;
}

export interface EnsureMemoryProvisionedInput {
  client: SupabaseClient;
  workspaceId: string;
  baseVersionId: string;
  documents: WorkspaceContextVersionRow["documents_json"];
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
  let baseVersionId = input.baseVersionId;
  let documents = input.documents;

  for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
    const additions = computeMemoryAdditions(documents, input.timezone, input.now ?? new Date());
    if (Object.keys(additions).length === 0) return { baseContextVersionId: baseVersionId };

    const result = await commitContextVersion(input.client, {
      workspaceId: input.workspaceId,
      expectedVersionId: baseVersionId,
      documents: { ...documents, ...additions },
      reason: "memory_provision",
      summary: `Provisioned ${Object.keys(additions).length} memory document(s)`,
    });
    if (result.status === "committed") return { baseContextVersionId: result.versionId };

    // Another write landed first. Read what is current and work out the stubs again.
    const current = await loadCurrentContext(input.client, input.workspaceId);
    if (!current.versionId) throw new Error("Workspace lost its context version while provisioning memory");
    baseVersionId = current.versionId;
    documents = current.documents;
  }
  throw new Error("Workspace context kept changing while provisioning memory");
}
