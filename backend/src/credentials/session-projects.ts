import type { SupabaseClient } from "@supabase/supabase-js";

interface SessionProjectRow {
  id: string;
}

// Idempotent on (workspace_id, project_key) — a repeated `enable` in the
// same project keeps resolving to the same session_projects row.
export async function findOrCreateSessionProject(
  client: SupabaseClient,
  workspaceId: string,
  projectKey: string,
  label: string | null,
): Promise<string> {
  const { data: existing, error: lookupError } = await client
    .from("session_projects")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("project_key", projectKey)
    .maybeSingle<SessionProjectRow>();
  if (lookupError) throw lookupError;
  if (existing) return existing.id;

  const { data: inserted, error: insertError } = await client
    .from("session_projects")
    .insert({ workspace_id: workspaceId, project_key: projectKey, label })
    .select("id")
    .single<SessionProjectRow>();
  if (insertError || !inserted) throw insertError ?? new Error("failed to create session project");
  return inserted.id;
}
