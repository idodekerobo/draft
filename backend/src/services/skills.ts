import { serviceClient } from "../db/client";
import type { SkillRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";

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
export async function listSkills(workspaceId: string): Promise<ListSkillsResult> {
  const { data, error } = await serviceClient
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

export async function loadActiveSkill(workspaceId: string, name: string): Promise<SkillRow | null> {
  const { data } = await serviceClient
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

export async function readSkill(workspaceId: string, name: string): Promise<ReadSkillResult> {
  const skill = await loadActiveSkill(workspaceId, name);
  if (!skill) return { ok: false, status: 404, error: "skill_not_found" };
  return { ok: true, skill: serializeSkill(skill) };
}
