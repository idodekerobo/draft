import type { SupabaseClient } from "@supabase/supabase-js";

export interface GithubInstallationWebhookPayload {
  action: string;
  installation: { id: number };
}

export interface GithubInstallationRepositoriesWebhookPayload {
  action: "added" | "removed";
  installation: { id: number };
  repositories_added?: Array<{ full_name: string }>;
  repositories_removed?: Array<{ full_name: string }>;
}

const STATUS_BY_ACTION: Record<string, "revoked" | "degraded" | "active" | undefined> = {
  deleted: "revoked",
  suspend: "degraded",
  unsuspend: "active",
};

// created/new_permissions_accepted are no-ops here -- the callback route
// (chunk 3) is authoritative for row creation, avoiding a race between the
// webhook and the browser redirect.
export async function handleInstallationEvent(
  payload: GithubInstallationWebhookPayload,
  client?: SupabaseClient,
): Promise<void> {
  const status = STATUS_BY_ACTION[payload.action];
  if (!status) return;

  const db = client ?? (await import("../../db/client")).serviceClient;
  const { error } = await db
    .from("source_connections")
    .update({ status })
    .eq("provider", "github")
    .eq("connection_key", String(payload.installation.id));
  if (error) throw error;
}

// Display only -- doesn't gate ingestion, since GitHub's own permission
// grant already scopes what the webhook/API can see.
export async function handleInstallationRepositoriesEvent(
  payload: GithubInstallationRepositoriesWebhookPayload,
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../../db/client")).serviceClient;

  const { data: connection, error: selectError } = await db
    .from("source_connections")
    .select("id, config_json")
    .eq("provider", "github")
    .eq("connection_key", String(payload.installation.id))
    .maybeSingle();
  if (selectError) throw selectError;
  if (!connection) return;

  const configJson = connection.config_json as Record<string, unknown>;
  const repos = new Set<string>(Array.isArray(configJson.repos) ? (configJson.repos as string[]) : []);
  for (const repo of payload.repositories_added ?? []) repos.add(repo.full_name);
  for (const repo of payload.repositories_removed ?? []) repos.delete(repo.full_name);

  const { error: updateError } = await db
    .from("source_connections")
    .update({ config_json: { ...configJson, repos: [...repos] } })
    .eq("id", connection.id);
  if (updateError) throw updateError;
}
