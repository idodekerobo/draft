import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import type { SkillRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { addSkill, listSkills, readSkill, resolveFields, serializeSkill, type AddOrUpdateBody } from "../services/skills";

type SkillsRequest = Bun.BunRequest<"/workspaces/:id/skills">;
type SkillRequest = Bun.BunRequest<"/workspaces/:id/skills/:name">;

export const skillsGET = withAuth<SkillsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const result = await listSkills(req.params.id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  const responseText = JSON.stringify({ skills: result.skills });
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "skills.list",
    argsJson: {},
    resultBytes: Buffer.byteLength(responseText, "utf8"),
  });
  return new Response(responseText, { headers: { "Content-Type": "application/json" } });
});

export const skillsREAD = withAuth<SkillRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const result = await readSkill(req.params.id, req.params.name);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  const responseText = JSON.stringify(result.skill);
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "skills.read",
    argsJson: { name: req.params.name },
    resultBytes: Buffer.byteLength(responseText, "utf8"),
  });
  return new Response(responseText, { headers: { "Content-Type": "application/json" } });
});

export const skillsPOST = withAuth<SkillsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: AddOrUpdateBody;
  try {
    body = (await req.json()) as AddOrUpdateBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await addSkill(req.params.id, caller.userId, body);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  return Response.json(result.skill, { status: 201 });
});

export const skillsPATCH = withAuth<SkillRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: AddOrUpdateBody;
  try {
    body = (await req.json()) as AddOrUpdateBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const resolved = resolveFields({ ...body, name: req.params.name });
  if (!resolved.ok) return Response.json({ error: resolved.error }, { status: resolved.status });
  const fields = resolved.fields;

  const { data, error } = await serviceClient
    .from("skills")
    .update({
      description: fields.description,
      license: fields.license,
      compatibility: fields.compatibility,
      metadata: fields.metadata,
      allowed_tools: fields.allowedTools,
      content: fields.content,
      updated_at: new Date().toISOString(),
      updated_by: caller.userId,
    })
    .eq("workspace_id", req.params.id)
    .eq("name", req.params.name)
    .is("removed_at", null)
    .select("*")
    .maybeSingle<SkillRow>();

  if (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "commit", errorCode: "skills_update_failed", error });
    return Response.json({ error: "skills_update_failed" }, { status: 500 });
  }
  if (!data) return Response.json({ error: "skill_not_found" }, { status: 404 });

  return Response.json(serializeSkill(data));
});

export const skillsDELETE = withAuth<SkillRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("skills")
    .update({ removed_at: new Date().toISOString() })
    .eq("workspace_id", req.params.id)
    .eq("name", req.params.name)
    .is("removed_at", null)
    .select("id")
    .maybeSingle<Pick<SkillRow, "id">>();

  if (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "commit", errorCode: "skills_remove_failed", error });
    return Response.json({ error: "skills_remove_failed" }, { status: 500 });
  }
  if (!data) return Response.json({ error: "skill_not_found" }, { status: 404 });

  return Response.json({ ok: true });
});
