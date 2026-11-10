import yaml from "js-yaml";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SkillRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";

/** The client a caller passes, or the service one, loaded on first use so code that passes its own never needs it. */
async function dbFor(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await import("../db/client")).serviceClient;
}

export function serializeSkill(row: SkillRow) {
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

export type SkillSummary = { name: string; description: string };

export type ListSkillsResult =
  | { ok: true; skills: SkillSummary[] }
  | { ok: false; status: number; error: string };

/** Caller must already have run assertWorkspaceAccess — this trusts workspaceId. */
export async function listSkills(workspaceId: string, client?: SupabaseClient): Promise<ListSkillsResult> {
  const db = await dbFor(client);
  const { data, error } = await db
    .from("skills")
    .select("name, description")
    .eq("workspace_id", workspaceId)
    .is("removed_at", null)
    .order("name", { ascending: true });
  if (error) {
    recordRouteError({ workspaceId, operation: "read", errorCode: "skills_list_failed", error });
    return { ok: false, status: 500, error: "skills_list_failed" };
  }

  const rows = (data ?? []) as Pick<SkillRow, "name" | "description">[];
  return { ok: true, skills: rows.map((row) => ({ name: row.name, description: row.description })) };
}

export async function loadActiveSkill(workspaceId: string, name: string, client?: SupabaseClient): Promise<SkillRow | null> {
  const db = await dbFor(client);
  const { data } = await db
    .from("skills")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("name", name)
    .is("removed_at", null)
    .maybeSingle<SkillRow>();
  return data ?? null;
}

export type ReadSkillResult =
  | { ok: true; skill: ReturnType<typeof serializeSkill> }
  | { ok: false; status: number; error: string };

export async function readSkill(workspaceId: string, name: string, client?: SupabaseClient): Promise<ReadSkillResult> {
  const skill = await loadActiveSkill(workspaceId, name, client);
  if (!skill) return { ok: false, status: 404, error: "skill_not_found" };
  return { ok: true, skill: serializeSkill(skill) };
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX_LENGTH = 64;
const CONTENT_MAX_BYTES = 100 * 1024;

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

export interface AddOrUpdateBody {
  name?: string;
  description?: string;
  content?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowed_tools?: string;
}

export interface ResolvedFields {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, unknown> | null;
  allowedTools: string | null;
  content: string;
}

export type ResolveResult =
  | { ok: true; fields: ResolvedFields }
  | { ok: false; status: number; error: string };

export function resolveFields(body: AddOrUpdateBody): ResolveResult {
  const content = typeof body.content === "string" ? body.content : "";
  if (content.length === 0) {
    return { ok: false, status: 400, error: "missing_content" };
  }
  if (Buffer.byteLength(content, "utf8") > CONTENT_MAX_BYTES) {
    return { ok: false, status: 413, error: "content_too_large" };
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

export type UpdateSkillResult =
  | { ok: true; skill: ReturnType<typeof serializeSkill> }
  | { ok: false; status: number; error: string };

/** Replaces a skill's content and fields. Caller must already have run assertWorkspaceAccess. */
export async function updateSkill(workspaceId: string, userId: string, name: string, body: AddOrUpdateBody, client?: SupabaseClient): Promise<UpdateSkillResult> {
  const resolved = resolveFields({ ...body, name });
  if (!resolved.ok) return resolved;
  const fields = resolved.fields;

  const db = await dbFor(client);
  const { data, error } = await db
    .from("skills")
    .update({
      description: fields.description,
      license: fields.license,
      compatibility: fields.compatibility,
      metadata: fields.metadata,
      allowed_tools: fields.allowedTools,
      content: fields.content,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq("workspace_id", workspaceId)
    .eq("name", name)
    .is("removed_at", null)
    .select("*")
    .maybeSingle<SkillRow>();

  if (error) {
    recordRouteError({ workspaceId, operation: "commit", errorCode: "skills_update_failed", error });
    return { ok: false, status: 500, error: "skills_update_failed" };
  }
  if (!data) return { ok: false, status: 404, error: "skill_not_found" };
  return { ok: true, skill: serializeSkill(data) };
}

export type RemoveSkillResult = { ok: true } | { ok: false; status: number; error: string };

/** Marks a skill removed; its row stays. Caller must already have run assertWorkspaceAccess. */
export async function removeSkill(workspaceId: string, name: string, client?: SupabaseClient): Promise<RemoveSkillResult> {
  const db = await dbFor(client);
  const { data, error } = await db
    .from("skills")
    .update({ removed_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("name", name)
    .is("removed_at", null)
    .select("id")
    .maybeSingle<Pick<SkillRow, "id">>();

  if (error) {
    recordRouteError({ workspaceId, operation: "commit", errorCode: "skills_remove_failed", error });
    return { ok: false, status: 500, error: "skills_remove_failed" };
  }
  if (!data) return { ok: false, status: 404, error: "skill_not_found" };
  return { ok: true };
}

export type AddSkillResult =
  | { ok: true; skill: ReturnType<typeof serializeSkill> }
  | { ok: false; status: number; error: string };

/** Caller must already have run assertWorkspaceAccess — this trusts workspaceId. */
export async function addSkill(workspaceId: string, userId: string, body: AddOrUpdateBody, client?: SupabaseClient): Promise<AddSkillResult> {
  const resolved = resolveFields(body);
  if (!resolved.ok) return resolved;
  const fields = resolved.fields;

  const db = await dbFor(client);
  const { data, error } = await db
    .from("skills")
    .insert({
      workspace_id: workspaceId,
      name: fields.name,
      description: fields.description,
      license: fields.license,
      compatibility: fields.compatibility,
      metadata: fields.metadata,
      allowed_tools: fields.allowedTools,
      content: fields.content,
      created_by: userId,
    })
    .select("*")
    .single<SkillRow>();

  if (error) {
    if (error.code === "23505") return { ok: false, status: 409, error: "duplicate_name" };
    recordRouteError({ workspaceId, operation: "commit", errorCode: "skills_add_failed", error });
    return { ok: false, status: 500, error: "skills_add_failed" };
  }
  return { ok: true, skill: serializeSkill(data) };
}
