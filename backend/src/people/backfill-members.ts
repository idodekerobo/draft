/**
 * Gives every active workspace member a person and a confirmed email identity.
 *   bun --env-file=.env.staging run backend/src/people/backfill-members.ts
 * It refuses to run on the production project unless you pass --allow-prod.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serviceClient } from "../db/client";
import { syncMembers } from "./sync-members";

const refOf = (url: string | undefined) => url?.match(/^https:\/\/([^.]+)\./)?.[1];

function prodRef(): string | undefined {
  const file = resolve(import.meta.dir, "../../../.env.production");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").find((entry) => entry.startsWith("SUPABASE_URL="));
  return refOf(line?.slice("SUPABASE_URL=".length).replace(/["']/g, ""));
}

const target = refOf(process.env.SUPABASE_URL);
if (!target) throw new Error("SUPABASE_URL is not set. Run with --env-file=.env.staging");
if (target === prodRef() && !process.argv.includes("--allow-prod")) {
  throw new Error("This is the production project. Pass --allow-prod only after you approved a production backfill.");
}

const { data: workspaces, error } = await serviceClient.from("workspaces").select("id, slug");
if (error) throw error;

for (const workspace of workspaces ?? []) {
  const before = await serviceClient.from("people").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id);
  await syncMembers(serviceClient, workspace.id);
  const after = await serviceClient.from("people").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id);
  console.log(`${workspace.slug}: ${before.count ?? 0} -> ${after.count ?? 0} people`);
}
