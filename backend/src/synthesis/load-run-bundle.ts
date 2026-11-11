import { parseWorkspaceId } from "draft-core/run-spec";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildValidatedRunBundle,
  type RunBundleLimits,
  type RunBundleSource,
  type ValidatedRunBundle,
} from "./context-version-files";
import type {
  AgentRunRow,
  AgentRunSourceItemRow,
  SourceItemRow,
  WorkspaceContextVersionRow,
} from "../types/tables";

export const PILOT_RUN_BUNDLE_LIMITS: Readonly<RunBundleLimits> = {
  maxFileBytes: 5_000_000,
  maxTotalBytes: 50_000_000,
};

export interface LoadRunBundleOptions {
  /** Select a specific immutable run; when omitted, select the newest run. */
  runId?: string;
  limits?: RunBundleLimits;
  client?: SupabaseClient;
}

type SelectedRun = Pick<
  AgentRunRow,
  "id" | "workspace_id" | "base_context_version_id" | "prompt_version"
>;

type Membership = Pick<
  AgentRunSourceItemRow,
  | "workspace_id"
  | "agent_run_id"
  | "source_item_id"
  | "source_item_version"
  | "content_hash"
  | "position"
>;

type Source = Pick<
  SourceItemRow,
  "id" | "workspace_id" | "external_version" | "content_markdown" | "content_hash"
>;

/**
 * Load canonical PostgreSQL rows for one synthesis run and pass them through
 * the pure run-bundle validator. This boundary is intentionally read-only.
 */
export async function loadValidatedRunBundle(
  options: LoadRunBundleOptions = {},
): Promise<ValidatedRunBundle> {
  const client =
    options.client ?? (await import("../db/client")).serviceClient;
  let runQuery = client
    .from("agent_runs")
    .select("id, workspace_id, base_context_version_id, prompt_version")
    .eq("kind", "synthesis")
    .order("created_at", { ascending: false });
  if (options.runId !== undefined) runQuery = runQuery.eq("id", options.runId);

  const { data: runData, error: runError } = await runQuery.limit(1).single();
  if (runError) throw runError;
  const run = runData as SelectedRun;

  const [workspaceResult, versionResult, membershipResult, peopleResult] = await Promise.all([
    client
      .from("workspaces")
      .select("id, organization_id, team_id")
      .eq("id", run.workspace_id)
      .single(),
    client
      .from("workspace_context_versions")
      .select("*")
      .eq("id", run.base_context_version_id)
      .single(),
    client
      .from("agent_run_source_items")
      .select(
        "workspace_id, agent_run_id, source_item_id, source_item_version, content_hash, position",
      )
      .eq("agent_run_id", run.id)
      .order("position", { ascending: true }),
    client.from("people").select("id, display_name, status").eq("workspace_id", run.workspace_id),
  ]);
  if (workspaceResult.error) throw workspaceResult.error;
  if (versionResult.error) throw versionResult.error;
  if (membershipResult.error) throw membershipResult.error;
  if (peopleResult.error) throw peopleResult.error;

  const workspace = workspaceResult.data as {
    id: string;
    organization_id: string;
    team_id: string;
  };
  const baseVersion = versionResult.data as WorkspaceContextVersionRow;
  const memberships = (membershipResult.data ?? []) as Membership[];

  let sourcesById = new Map<string, Source>();
  if (memberships.length > 0) {
    // Filtered by workspace_id, not by the membership id list itself -- an
    // .in() over that list put every id in the request URL, which stops
    // working once a run's membership set gets large enough (~600+ ids).
    const sourceResult = await client
      .from("source_items")
      .select("id, workspace_id, external_version, content_markdown, content_hash")
      .eq("workspace_id", run.workspace_id);
    if (sourceResult.error) throw sourceResult.error;
    sourcesById = new Map(
      ((sourceResult.data ?? []) as Source[]).map((source) => [source.id, source]),
    );
  }

  const sources: RunBundleSource[] = memberships.map((membership) => {
    const item = sourcesById.get(membership.source_item_id);
    if (!item) throw new Error(`Missing source item ${membership.source_item_id}`);
    return { item, membership };
  });

  return buildValidatedRunBundle({
    audience: { type: "system", workspaceId: parseWorkspaceId(workspace.id) },
    identity: {
      organizationId: workspace.organization_id,
      teamId: workspace.team_id,
      workspaceId: workspace.id,
    },
    run,
    baseVersion,
    sources,
    people: ((peopleResult.data ?? []) as Array<{ id: string; display_name: string; status: "pending" | "active" | "rejected" }>).map((person) => ({
      id: person.id,
      name: person.display_name,
      status: person.status,
    })),
    limits: options.limits ?? { ...PILOT_RUN_BUNDLE_LIMITS },
  });
}
