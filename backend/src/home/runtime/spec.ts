import { SANDBOX_SESSION_DIRECTORY, parseAgentRunId, parseContextVersionId, parseUserId, parseWorkspaceId, sandboxComputer, type AgentRunSpec } from "draft-core/run-spec";
import type { HarnessId } from "draft-core/harnesses";
import type { AnyDraftToolPermission } from "draft-core/tools";

export const HOME_ADAPTER_ID = "pi-durable-sdk";
/** What the backend ran Home on, recorded on each run. */
export const HOME_RUNTIME_VERSION = "pi-durable@1.6.1";
/** pi's id of the conversation Home runs in. It is the root: a harness switch starts a new engine conversation. */
export const HOME_CONVERSATION_ID = 1;
export const DEFAULT_HOME_MODEL = "claude-sonnet-5-5";

/**
 * The limits Home's own run carries for the tools that need them. Home calls Draft's tools as its owner, so this list does not
 * grant anything: it names the tools that have run limits, and `people.notify` refuses a run that is not listed here.
 */
export function homePermissions(): AnyDraftToolPermission[] {
  return [
    { tool: "people.notify", limits: { recipients: "members", maxPerRun: 10 } },
    { tool: "people.notification_status" },
    { tool: "people.create", limits: { maxPerRun: 5 } },
    { tool: "people.update", limits: { maxPerRun: 20 } },
  ];
}

export interface HomeRunSpecInput {
  runId: string;
  workspaceId: string;
  ownerUserId: string;
  sessionId: string;
  model: string | null;
  contextVersionId: string;
  instructions: string;
}

/** The spec of one Home work episode: the owner's agent, in Draft's backend, with a sandbox computer allocated on first use. */
export function buildHomeRunSpec(input: HomeRunSpecInput): AgentRunSpec {
  return {
    id: parseAgentRunId(input.runId),
    kind: "interactive",
    workspaceId: parseWorkspaceId(input.workspaceId),
    trigger: { type: "manual", requestedBy: parseUserId(input.ownerUserId) },
    onBehalfOf: parseUserId(input.ownerUserId),
    execution: { target: { type: "backend", packageVersion: HOME_RUNTIME_VERSION }, adapterId: HOME_ADAPTER_ID as never },
    toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] },
    computer: sandboxComputer("open", SANDBOX_SESSION_DIRECTORY),
    continuation: { type: "durable", storageId: input.sessionId, conversationId: HOME_CONVERSATION_ID },
    harness: "pi" as HarnessId,
    model: input.model,
    reasoningEffort: null,
    instructions: input.instructions,
    inputs: { contextVersionId: parseContextVersionId(input.contextVersionId) },
    permissions: homePermissions(),
    output: { type: "text" },
  };
}
