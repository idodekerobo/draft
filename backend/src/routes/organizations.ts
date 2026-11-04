import { z } from "zod";
import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { slugify, withRandomSuffix } from "../organizations/slug";
import { createInitialWorkspaceSynthesis } from "../synthesis/register-workspace-synthesis";

const BodySchema = z.object({ name: z.string().trim().min(1).max(80) });

const MAX_SLUG_ATTEMPTS = 4;
const UNIQUE_VIOLATION = "23505";

interface CreatedOrganization {
  organization_id: string;
  team_id: string;
  workspace_id: string;
}

export const POST = withAuth(async (req, caller) => {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_name" }, { status: 400 });
  const { name } = body.data;

  const baseSlug = slugify(name);
  let created: CreatedOrganization | null = null;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !created; attempt++) {
    const { data, error } = await serviceClient.rpc("create_organization_for_user", {
      p_user_id: caller.userId,
      p_org_name: name,
      p_org_slug: attempt === 0 ? baseSlug : withRandomSuffix(baseSlug),
      p_workspace_slug: baseSlug,
    });
    if (!error) {
      created = data as CreatedOrganization;
      break;
    }
    if (error.message === "already_in_organization") return Response.json({ error: "already_in_organization" }, { status: 409 });
    if (error.message === "user_not_found") return Response.json({ error: "not_found" }, { status: 404 });
    if (error.code !== UNIQUE_VIOLATION) {
      console.error("create organization failed", { userId: caller.userId, error: error.message });
      return Response.json({ error: "create_failed" }, { status: 500 });
    }
  }
  if (!created) return Response.json({ error: "slug_unavailable" }, { status: 500 });

  // The org already exists at this point, and this call is idempotent, so a failure is logged and not surfaced.
  try {
    await createInitialWorkspaceSynthesis({ id: created.workspace_id });
  } catch (error) {
    console.error("initial workspace synthesis registration failed", { workspaceId: created.workspace_id, error });
  }

  return Response.json({ ...created, organization_name: name }, { status: 201 });
});
