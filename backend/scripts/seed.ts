// Throwaway seed script. Run: bun run backend/scripts/seed.ts

import { serviceClient } from "../src/db/client";

interface SeedOrgSpec {
  orgSlug: string;
  orgName: string;
  teamSlug: string;
  teamName: string;
  workspaceSlug: string;
  workspaceName: string;
  userEmail: string;
  userPassword: string;
  userDisplayName: string;
}

const SEEDS: SeedOrgSpec[] = [
  {
    orgSlug: "big",
    orgName: "BIG",
    teamSlug: "core",
    teamName: "BIG Core",
    workspaceSlug: "main",
    workspaceName: "BIG Workspace",
    userEmail: "pilot-big@draft.test",
    userPassword: "draft-pilot-big-test-only",
    userDisplayName: "BIG Pilot User",
  },
  {
    orgSlug: "folia",
    orgName: "Folia",
    teamSlug: "core",
    teamName: "Folia Core",
    workspaceSlug: "main",
    workspaceName: "Folia Workspace",
    userEmail: "pilot-folia@draft.test",
    userPassword: "draft-pilot-folia-test-only",
    userDisplayName: "Folia Pilot User",
  },
];

async function seedOne(spec: SeedOrgSpec) {
  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .upsert({ slug: spec.orgSlug, name: spec.orgName }, { onConflict: "slug" })
    .select()
    .single();
  if (orgError) throw orgError;

  const { data: team, error: teamError } = await serviceClient
    .from("teams")
    .upsert(
      {
        organization_id: org.id,
        slug: spec.teamSlug,
        name: spec.teamName,
      },
      { onConflict: "organization_id,slug" },
    )
    .select()
    .single();
  if (teamError) throw teamError;

  const { data: workspace, error: workspaceError } = await serviceClient
    .from("workspaces")
    .upsert(
      {
        organization_id: org.id,
        team_id: team.id,
        slug: spec.workspaceSlug,
        name: spec.workspaceName,
      },
      { onConflict: "team_id,slug" },
    )
    .select()
    .single();
  if (workspaceError) throw workspaceError;

  // createUser errors on an existing email, so look it up first.
  const { data: existingUsers, error: listError } =
    await serviceClient.auth.admin.listUsers();
  if (listError) throw listError;
  let authUserId = existingUsers.users.find(
    (u) => u.email === spec.userEmail,
  )?.id;

  if (!authUserId) {
    const { data: created, error: createError } =
      await serviceClient.auth.admin.createUser({
        email: spec.userEmail,
        password: spec.userPassword,
        email_confirm: true,
      });
    if (createError) throw createError;
    authUserId = created.user.id;
  }

  const { error: userRowError } = await serviceClient.from("users").upsert({
    id: authUserId,
    email: spec.userEmail,
    display_name: spec.userDisplayName,
    organization_id: org.id,
    primary_team_id: team.id,
    organization_role: "owner",
    status: "active",
  });
  if (userRowError) throw userRowError;

  console.log(
    `Seeded ${spec.orgName}: org=${org.id} team=${team.id} workspace=${workspace.id} user=${authUserId} (${spec.userEmail} / ${spec.userPassword})`,
  );
}

for (const spec of SEEDS) {
  await seedOne(spec);
}
