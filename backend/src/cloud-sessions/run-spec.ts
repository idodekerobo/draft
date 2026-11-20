import { cloudToolsetFor } from "draft-core/harnesses";
import { parseAgentRunId, parseContextVersionId, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import type { AnyDraftToolPermission } from "draft-core/tools";

/**
 * The run-scoped tools of a cloud session. It also gets every tool its owner can call over MCP, as the owner,
 * through the run gateway; these are the ones that belong to the run itself.
 */
export function cloudSessionPermissions(repo: string | null): AnyDraftToolPermission[] {
  const permissions: AnyDraftToolPermission[] = [
    { tool: "context.read" }, { tool: "context.list" }, { tool: "context.write" }, { tool: "context.export" },
    { tool: "sources.search" }, { tool: "sources.read" },
    { tool: "skills.list" }, { tool: "skills.read" }, { tool: "skills.add" }, { tool: "skills.update" }, { tool: "skills.delete" },
    { tool: "routines.runs" },
  ];
  // Write, so the agent can push a branch. The token covers only the seed repository.
  if (repo) permissions.push({ tool: "github.credential", limits: { repos: [repo], access: "write" } });
  return permissions;
}

export interface CloudRunSpecInput {
  runId: string;
  workspaceId: string;
  ownerUserId: string;
  model: string | null;
  reasoningEffort: string | null;
  network: "restricted" | "open";
  contextVersionId: string;
  /** "owner/name" of the seed repository, or null when there is none. */
  repo: string | null;
}

/** The spec of one run of a cloud session. The session wakes by starting a new run, so each run has its own spec. */
export function buildCloudRunSpec(input: CloudRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.runId),
    kind: "interactive",
    network: input.network,
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: { type: "manual", requestedBy: parseUserId(input.ownerUserId) },
    // The session is the owner's own agent, as a local session is: it calls Draft as the owner.
    onBehalfOf: parseUserId(input.ownerUserId),
    runtime: { type: "cloud", toolset: cloudToolsetFor("claude") },
    harness: "claude",
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: cloudSessionPermissions(input.repo),
    output: { type: "text" },
  };
}
