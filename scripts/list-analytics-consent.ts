#!/usr/bin/env bun
// Lists the members of a workspace and whether each one has agreed to analytics.
// PostHog sends events only for users who agreed, so a member without consent is
// invisible in the live-session gate numbers. Run it at each pilot onboarding.
//
//   bun --env-file=.env.staging run scripts/list-analytics-consent.ts <workspace id>
//
// Use .env.production only when you mean the production project.
// Exit code 2 means at least one member has not agreed.

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error("Usage: bun --env-file=.env.staging run scripts/list-analytics-consent.ts <workspace id>");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");
  process.exit(1);
}

async function rest<T>(path: string): Promise<T> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key!, Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return (await response.json()) as T;
}

interface Member {
  display_name: string | null;
  email: string | null;
  analytics_consent: boolean | null;
}

try {
  const [workspace] = await rest<Array<{ organization_id: string; team_id: string }>>(
    `workspaces?select=organization_id,team_id&id=eq.${encodeURIComponent(workspaceId)}`,
  );
  if (!workspace) {
    console.error("Workspace not found in this project.");
    process.exit(1);
  }
  const members = await rest<Member[]>(
    `users?select=display_name,email,analytics_consent&organization_id=eq.${workspace.organization_id}&primary_team_id=eq.${workspace.team_id}&status=eq.active&order=display_name`,
  );

  const label = (value: boolean | null) => (value === true ? "on" : value === false ? "OFF" : "not asked");
  for (const member of members) console.log(`${label(member.analytics_consent).padEnd(10)} ${member.display_name ?? member.email}`);
  const missing = members.filter((member) => member.analytics_consent !== true).length;
  console.log(`\n${members.length} members, ${missing} without consent.`);
  process.exit(missing > 0 ? 2 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not read members.");
  process.exit(1);
}
