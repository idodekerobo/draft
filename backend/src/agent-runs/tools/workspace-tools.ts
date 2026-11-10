import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/agent-run";
import { defineTool } from "../tool-registry";

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
const descriptionField = z.string().min(1).describe("One or two sentences on what the skill does and when to use it. May come from the content's frontmatter.");

const skillAudit = (input: { name?: string; content: string }) => ({ name: input.name, contentBytes: Buffer.byteLength(input.content, "utf8") });

/** A failed lookup or write is an answer for the caller, not a crash: it comes back as `{ error }`, as these tools always did. */
const answer = <R extends { ok: boolean }>(result: R, pick: (ok: Extract<R, { ok: true }>) => unknown) =>
  result.ok ? pick(result as Extract<R, { ok: true }>) : { error: (result as unknown as { error: string }).error };

/** The skill and routine tools. They need a person: a run has no workspace member to act for. */
export function createWorkspaceTools(client: SupabaseClient) {
  const list = defineTool({
    name: "skills.list",
    description: "List the skills (reusable playbooks/templates) available in the caller's workspace.",
    callers: ["user"],
    input: z.object({}),
    handler: async ({ caller }) => {
      const user = requireUser(caller, "skills.list");
      const result = await (await skillsService()).listSkills(user.workspaceId, client);
      return { status: "ok", output: answer(result, (ok) => ({ skills: ok.skills })) };
    },
  });

  const read = defineTool({
    name: "skills.read",
    description: "Read one skill's full content by name.",
    callers: ["user"],
    input: z.object({ name: z.string().describe("The skill's name, as returned by skills.list.") }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "skills.read");
      const result = await (await skillsService()).readSkill(user.workspaceId, input.name, client);
      return { status: "ok", output: answer(result, (ok) => ok.skill) };
    },
  });

  const add = defineTool({
    name: "skills.add",
    description:
      "Create a new shared skill for the whole team. Use only when the user asks to save a skill. Write the description for a teammate who was not in this session. Fails with duplicate_name if the name exists; it cannot overwrite a skill.",
    callers: ["user"],
    input: z.object({
      name: z.string().optional().describe("Lowercase words joined by hyphens, e.g. weekly-customer-recap. Max 64 characters. May come from the content's frontmatter."),
      description: descriptionField.optional(),
      ...skillFields,
    }),
    auditArguments: skillAudit,
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "skills.add");
      const result = await (await skillsService()).addSkill(user.workspaceId, user.userId, input, client);
      return { status: "ok", output: answer(result, (ok) => ok.skill) };
    },
  });

  const update = defineTool({
    name: "skills.update",
    description: "Replace an existing skill's content and fields. Fails with skill_not_found if the name does not exist.",
    callers: ["user"],
    input: z.object({ name: z.string().describe("The skill's name, as returned by skills.list."), description: descriptionField.optional(), ...skillFields }),
    auditArguments: skillAudit,
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "skills.update");
      const { name, ...body } = input;
      const result = await (await skillsService()).updateSkill(user.workspaceId, user.userId, name, body, client);
      return { status: "ok", output: answer(result, (ok) => ok.skill) };
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
      return { status: "ok", output: answer(result, () => ({ ok: true })) };
    },
  });

  const routines = defineTool({
    name: "routines.list",
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
