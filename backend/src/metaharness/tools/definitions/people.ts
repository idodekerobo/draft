import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { findToolPermission, type DraftToolLimits, type ToolCaller } from "draft-core/tools";
import { createPerson } from "../../../people/create";
import { decidePerson, isAdmin } from "../../../people/decide";
import { findPeople } from "../../../people/find";
import { addPersonIdentity } from "../../../people/identities";
import { countRunToolCalls } from "../../../people/limits";
import { syncMembers } from "../../../people/sync-members";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
import { callerWorkspaceId, requireUser } from "./shared";

const PROVIDERS = ["email", "slack", "linear", "github", "whatsapp"] as const;

const DEFAULT_MAX_CREATES_PER_RUN = 5;
const DEFAULT_MAX_IDENTITIES_PER_RUN = 10;

const evidenceSchema = z.object({
  sourceItemId: z.string().uuid().optional().describe("The source the person was found in, from sources.search."),
  quote: z.string().min(1).max(500).describe("The exact words that show who this is and why they belong on the team."),
});

const identitySchema = z.object({
  provider: z.enum(PROVIDERS),
  externalId: z.string().min(1).describe("A stable id: the email address, Slack member id (U…), Linear user id, GitHub numeric id or phone number."),
  handle: z.string().optional().describe("A name for display. It is not used to match."),
});

/** The most times a run may use a tool, from the permission that was fixed when the run started. */
function runLimit(caller: Extract<ToolCaller, { type: "run" }>, tool: "people.create" | "people.add_identity", fallback: number): number {
  const limits = findToolPermission(caller.run, tool)?.limits as DraftToolLimits[typeof tool] | undefined;
  return limits?.maxPerRun ?? fallback;
}

async function overRunLimit(client: SupabaseClient, caller: ToolCaller, tool: "people.create" | "people.add_identity", fallback: number): Promise<ToolHandlerResult | null> {
  if (caller.type !== "run") return null;
  const max = runLimit(caller, tool, fallback);
  if ((await countRunToolCalls(client, caller.run.id, tool)) < max) return null;
  return refuse("limit_reached", `This run has used ${tool} ${max} times, which is its limit. Stop and report what is left.`);
}

/** The people tools. A person needs an account to approve or reject; a run can find, add and add identities within limits. */
export function createPeopleTools(client: SupabaseClient) {
  const find = defineTool({
    name: "people.find",
    mcp: true,
    description:
      "Find people in the workspace: teammates and others Draft has noted. Filter by name, email, or a provider id; pass me: true for yourself (the person you are working for). " +
      "Returns id, name, status, whether they have an account, and whether Slack can reach them. It never returns emails or ids. " +
      "Call this before people.create, and before people.notify to turn a name into an id. A pending person can be named but not messaged.",
    input: z.object({
      me: z.boolean().optional().describe("The person you act for."),
      name: z.string().min(1).optional().describe("Part of a name, any case."),
      email: z.string().optional(),
      provider: z.enum(PROVIDERS).optional(),
      externalId: z.string().optional().describe("Needs provider."),
      status: z.enum(["pending", "active", "rejected"]).optional(),
    }),
    handler: async ({ input, caller }) => {
      const workspaceId = callerWorkspaceId(caller);
      await syncMembers(client, workspaceId);

      let userId: string | undefined;
      if (input.me) {
        const self = caller.type === "user" ? caller.userId : caller.run.onBehalfOf;
        if (!self) return refuse("not_allowed", "This run acts for no one, so it has no self. Name the person instead.");
        userId = self;
      }
      const { me: _me, ...filters } = input;
      const people = await findPeople(client, workspaceId, { ...filters, userId });
      return { status: "ok", output: { people }, summary: `found ${people.length}` };
    },
  });

  const create = defineTool({
    name: "people.create",
    mcp: true,
    description:
      "Add a teammate Draft does not know yet, for example someone new named in a meeting. Only add teammates, not clients, guests or people who are only mentioned. " +
      "Call people.find first. Give the exact quote that shows who they are. A person you add waits for an admin to approve; you cannot message them or approve them. " +
      "If Draft already knows the person, or a similar name, you get that back instead and nothing is created.",
    input: z.object({
      displayName: z.string().min(1).max(120),
      evidence: evidenceSchema,
      identities: z.array(identitySchema).max(5).optional(),
      force: z.boolean().optional().describe("Add anyway when the similar name is a different person. It never overrides an identity match or a rejection."),
    }),
    auditArguments: (input) => ({ displayName: input.displayName, evidence: input.evidence, identityCount: input.identities?.length ?? 0, force: input.force ?? false }),
    handler: async ({ input, caller }) => {
      const workspaceId = callerWorkspaceId(caller);
      const limited = await overRunLimit(client, caller, "people.create", DEFAULT_MAX_CREATES_PER_RUN);
      if (limited) return limited;
      await syncMembers(client, workspaceId);

      const actor =
        caller.type === "run"
          ? ({ type: "run", runId: caller.run.id, onBehalfOf: caller.run.onBehalfOf } as const)
          : ({ type: "user", userId: caller.userId, isAdmin: await isAdmin(client, caller.userId) } as const);
      const result = await createPerson(client, workspaceId, actor, input);
      const summary = "person" in result ? (result.created ? `created ${result.person.displayName}` : `already known: ${result.person.displayName}`) : "candidates" in result ? "similar names found" : "name was rejected before";
      return { status: "ok", output: result, summary };
    },
  });

  const addIdentityTool = defineTool({
    name: "people.add_identity",
    mcp: true,
    description:
      "Record another way to recognise a known person, such as their Slack id. What you add is a guess until a connection or an admin confirms it, so it cannot be used to message them. " +
      "Fails with identity_taken if that id belongs to someone else.",
    input: z.object({
      personId: z.string().uuid(),
      provider: z.enum(PROVIDERS),
      externalId: z.string().min(1),
      handle: z.string().optional(),
      evidence: evidenceSchema.partial(),
    }),
    handler: async ({ input, caller }) => {
      const workspaceId = callerWorkspaceId(caller);
      const limited = await overRunLimit(client, caller, "people.add_identity", DEFAULT_MAX_IDENTITIES_PER_RUN);
      if (limited) return limited;

      const result = await addPersonIdentity(client, workspaceId, input);
      if (!result.ok) {
        return refuse(result.code, result.code === "identity_taken" ? "That id already belongs to another person." : "No person with that id in this workspace.");
      }
      return { status: "ok", output: { outcome: result.outcome }, summary: result.outcome };
    },
  });

  const approve = defineTool({
    name: "people.approve",
    mcp: true,
    description: "Approve a pending person so they become an active teammate who can be messaged. Admins only. Only a person can do this, never an agent run.",
    callers: ["user"],
    input: z.object({ personId: z.string().uuid() }),
    handler: async ({ input, caller }) => decide(caller, input.personId, "active"),
  });

  const reject = defineTool({
    name: "people.reject",
    mcp: true,
    description: "Turn away a pending person. Draft remembers the name, so synthesis does not add them again. Admins only. Only a person can do this, never an agent run.",
    callers: ["user"],
    input: z.object({ personId: z.string().uuid(), reason: z.string().max(500).optional() }),
    handler: async ({ input, caller }) => decide(caller, input.personId, "rejected", input.reason),
  });

  async function decide(caller: ToolCaller, personId: string, to: "active" | "rejected", reason?: string): Promise<ToolHandlerResult> {
    const user = requireUser(caller, to === "active" ? "people.approve" : "people.reject");
    if (!(await isAdmin(client, user.userId))) return refuse("not_admin", "Only an admin can approve or reject people.");
    const result = await decidePerson(client, user.workspaceId, user.userId, { personId, to, reason });
    if (!result.ok) {
      return refuse(result.code, result.code === "already_decided" ? "This person is not waiting for a decision." : "No person with that id in this workspace.");
    }
    return { status: "ok", output: { person: result.person }, summary: `${to === "active" ? "approved" : "rejected"} ${result.person.displayName}` };
  }

  return [find, create, addIdentityTool, approve, reject];
}
