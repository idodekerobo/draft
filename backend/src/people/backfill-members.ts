/**
 * Gives every active workspace member a person and a confirmed email identity.
 *   bun --env-file=.env.staging run backend/src/people/backfill-members.ts
 * It refuses to run on the production project unless you pass --allow-prod.
 */
import { serviceClient } from "../db/client";
import { assertNotProduction, readProductionEnvText } from "./production-guard";
import { syncMembers } from "./sync-members";

assertNotProduction(process.env.SUPABASE_URL, readProductionEnvText(import.meta.dir), {
  allowProd: process.argv.includes("--allow-prod"),
  what: "Pass --allow-prod only after you approved a production backfill.",
});

const { data: workspaces, error } = await serviceClient.from("workspaces").select("id, slug");
if (error) throw error;

for (const workspace of workspaces ?? []) {
  const before = await serviceClient.from("people").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id);
  await syncMembers(serviceClient, workspace.id);
  const after = await serviceClient.from("people").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id);
  console.log(`${workspace.slug}: ${before.count ?? 0} -> ${after.count ?? 0} people`);
}
