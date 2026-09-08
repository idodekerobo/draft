import yaml from "js-yaml";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import type { SkillRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";
import { recordAgentQueryLog } from "../observability/record-query-log";

type SkillsRequest = Bun.BunRequest<"/workspaces/:id/skills">;
type SkillRequest = Bun.BunRequest<"/workspaces/:id/skills/:name">;

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX_LENGTH = 64;

interface FrontmatterFields {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string;
}

type FrontmatterResult =
  | { ok: true; fields: FrontmatterFields | null }
  | { ok: false };

/** Parses a leading `---\n...\n---` YAML block, if any. Malformed YAML is a failure, not a no-op. */
function parseFrontmatter(content: string): FrontmatterResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return { ok: true, fields: null };

  let parsed: unknown;
  try {
    parsed = yaml.load(match[1]!);
  } catch {
    return { ok: false };
  }
  if (parsed === null || parsed === undefined) return { ok: true, fields: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };

  const body = parsed as Record<string, unknown>;
  const fields: FrontmatterFields = {};
  if (typeof body.name === "string") fields.name = body.name;
  if (typeof body.description === "string") fields.description = body.description;
  if (typeof body.license === "string") fields.license = body.license;
  if (typeof body.compatibility === "string") fields.compatibility = body.compatibility;
  if (typeof body["allowed-tools"] === "string") fields.allowedTools = body["allowed-tools"] as string;
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    fields.metadata = body.metadata as Record<string, unknown>;
  }
  return { ok: true, fields };
}

function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX_LENGTH && NAME_PATTERN.test(name);
}

interface AddOrUpdateBody {
  name?: string;
  description?: string;
  content?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowed_tools?: string;
}

interface ResolvedFields {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, unknown> | null;
  allowedTools: string | null;
  content: string;
}

type ResolveResult =
  | { ok: true; fields: ResolvedFields }
  | { ok: false; status: number; error: string };

function resolveFields(body: AddOrUpdateBody): ResolveResult {
  const content = typeof body.content === "string" ? body.content : "";
  if (content.length === 0) {
    return { ok: false, status: 400, error: "missing_content" };
  }

  const frontmatter = parseFrontmatter(content);
  if (!frontmatter.ok) {
    return { ok: false, status: 400, error: "malformed_frontmatter" };
  }
  const parsed = frontmatter.fields ?? {};

  const name = body.name ?? parsed.name;
  const description = body.description ?? parsed.description;
  if (!name || !description) {
    return { ok: false, status: 400, error: "missing_required_fields" };
  }
  if (!isValidName(name)) {
    return { ok: false, status: 400, error: "invalid_name" };
  }

  return {
    ok: true,
    fields: {
      name,
      description,
      license: body.license ?? parsed.license ?? null,
      compatibility: body.compatibility ?? parsed.compatibility ?? null,
      metadata: body.metadata ?? parsed.metadata ?? null,
      allowedTools: body.allowed_tools ?? parsed.allowedTools ?? null,
      content,
    },
  };
}

function serializeSkill(row: SkillRow) {
  return {
    name: row.name,
    description: row.description,
    license: row.license,
    compatibility: row.compatibility,
    metadata: row.metadata,
    allowedTools: row.allowed_tools,
    content: row.content,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export const skillsGET = withAuth<SkillsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("skills")
    .select("name, description")
    .eq("workspace_id", req.params.id)
    .is("removed_at", null)
    .order("name", { ascending: true });
  if (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "skills_list_failed", error });
    return Response.json({ error: "skills_list_failed" }, { status: 500 });
  }

  const rows = (data ?? []) as Pick<SkillRow, "name" | "description">[];
  const body = { skills: rows.map((row) => ({ name: row.name, description: row.description })) };
  const responseText = JSON.stringify(body);
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "skills.list",
    argsJson: {},
    resultBytes: Buffer.byteLength(responseText, "utf8"),
  });
  return new Response(responseText, { headers: { "Content-Type": "application/json" } });
});

async function loadActiveSkill(workspaceId: string, name: string): Promise<SkillRow | null> {
  const { data } = await serviceClient
    .from("skills")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("name", name)
    .is("removed_at", null)
    .maybeSingle<SkillRow>();
  return data ?? null;
}

export const skillsREAD = withAuth<SkillRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const skill = await loadActiveSkill(req.params.id, req.params.name);
  if (!skill) return Response.json({ error: "skill_not_found" }, { status: 404 });

  const responseText = JSON.stringify(serializeSkill(skill));
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

  const resolved = resolveFields(body);
  if (!resolved.ok) return Response.json({ error: resolved.error }, { status: resolved.status });
  const fields = resolved.fields;

  const { data, error } = await serviceClient
    .from("skills")
    .insert({
      workspace_id: req.params.id,
      name: fields.name,
      description: fields.description,
      license: fields.license,
      compatibility: fields.compatibility,
      metadata: fields.metadata,
      allowed_tools: fields.allowedTools,
      content: fields.content,
      created_by: caller.userId,
    })
    .select("*")
    .single<SkillRow>();

  if (error) {
    if (error.code === "23505") return Response.json({ error: "duplicate_name" }, { status: 409 });
    recordRouteError({ workspaceId: req.params.id, operation: "commit", errorCode: "skills_add_failed", error });
    return Response.json({ error: "skills_add_failed" }, { status: 500 });
  }

  return Response.json(serializeSkill(data), { status: 201 });
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
