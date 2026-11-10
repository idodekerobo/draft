import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/agent-run";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";

// Loaded on first use: these services open the service database client, which a registry built for a test must not need.
const skillsService = () => import("../../services/skills");
const scheduleService = () => import("../../schedules/service");

function requireUser(caller: ToolCaller, tool: string) {
  if (caller.type !== "user") throw new Error(`${tool} needs a signed-in person`);
  return caller;
}

const skillFields = {
  content: z.string().min(1).describe("The full skill in markdown. May start with YAML frontmatter."),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowed_tools: z.string().optional(),
};
const descriptionField = z.string().min(1).describe("One or two sentences on what the skill does and when to use it.");

const skillAudit = (input: { name: string; content: string }) => ({ name: input.name, contentBytes: Buffer.byteLength(input.content, "utf8") });

const SKILL_MESSAGES: Record<string, string> = {
  skill_not_found: "No skill with that name. Use skills.list to see the names.",
  duplicate_name: "A skill with that name already exists. Use skills.update to change it.",
  invalid_name: "The name must be lowercase letters, numbers and hyphens, 1-64 characters, with no leading, trailing or doubled hyphen.",
  missing_required_fields: "A name and a description are required.",
  missing_content: "The skill has no content.",
  malformed_frontmatter: "The content starts with YAML frontmatter that could not be parsed.",
  content_too_large: "The skill content is too large.",
};

/** A skill call that did not work: a missing or taken name is a refusal, a database failure is not. */
function skillRefusal(result: { status: number; error: string }): ToolHandlerResult {
  if (result.status >= 500) throw new Error(result.error);
  return refuse(result.error, SKILL_MESSAGES[result.error] ?? result.error);
}

/** The skill and routine tools. They need a person: a run has no workspace member to act for. */
export function createWorkspaceTools(client: SupabaseClient) {
  const list = defineTool({
    name: "skills.list",
    mcp: true,
    description: "List the skills (reusable playbooks/templates) available in the caller's workspace.",
    callers: ["user"],
    input: z.object({}),
    handler: async ({ caller }) => {
      const user = requireUser(caller, "skills.list");
      const result = await (await skillsService()).listSkills(user.workspaceId, client);
      return result.ok ? { status: "ok", output: { skills: result.skills } } : skillRefusal(result);
    },
  });

  const read = defineTool({
    name: "skills.read",
    mcp: true,
    description: "Read one skill's full content by name.",
    callers: ["user"],
    input: z.object({ name: z.string().describe("The skill's name, as returned by skills.list.") }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "skills.read");
      const result = await (await skillsService()).readSkill(user.workspaceId, input.name, client);
      return result.ok ? { status: "ok", output: result.skill } : skillRefusal(result);
    },
  });

  const add = defineTool({
    name: "skills.add",
    mcp: true,
    description:
      "Create a new shared skill for the whole team. Use only when the user asks to save a skill. Write the description for a teammate who was not in this session. Fails with duplicate_name if the name exists; it cannot overwrite a skill.",
    callers: ["user"],
    input: z.object({
      name: z.string().describe("Lowercase words joined by hyphens, e.g. weekly-customer-recap. Max 64 characters."),
      description: descriptionField,
      ...skillFields,
    }),
    auditArguments: skillAudit,
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "skills.add");
      const result = await (await skillsService()).addSkill(user.workspaceId, user.userId, input, client);
      return result.ok ? { status: "ok", output: result.skill } : skillRefusal(result);
    },
  });

  const update = defineTool({
    name: "skills.update",
    description: "Replace an existing skill's content and fields. Fails with skill_not_found if the name does not exist.",
    callers: ["user"],
    input: z.object({ name: z.string().describe("The skill's name, as returned by skills.list."), description: descriptionField, ...skillFields }),
    auditArguments: skillAudit,
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "skills.update");
      const { name, ...body } = input;
      const result = await (await skillsService()).updateSkill(user.workspaceId, user.userId, name, body, client);
      return result.ok ? { status: "ok", output: result.skill } : skillRefusal(result);
    },
  });

  const remove = defineTool({
    name: "skills.delete",
    description: "Remove a skill from the workspace. Fails with skill_not_found if the name does not exist.",
    callers: ["user"],
    input: z.object({ name: z.string() }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "skills.delete");
      const result = await (await skillsService()).removeSkill(user.workspaceId, input.name, client);
      return result.ok ? { status: "ok", output: { ok: true } } : skillRefusal(result);
    },
  });

  const routines = defineTool({
    name: "routines.list",
    mcp: true,
    description: "List the routines (scheduled background tasks) in the caller's workspace, with schedule, cron expression, enabled state, and next run.",
    callers: ["user"],
    input: z.object({}),
    handler: async ({ caller }) => {
      const user = requireUser(caller, "routines.list");
      return { status: "ok", output: { routines: await (await scheduleService()).listRoutines(user.workspaceId) } };
    },
  });

  return [list, read, add, update, remove, routines];
}
