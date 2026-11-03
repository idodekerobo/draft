import { cleanAnswers, summarizeToolInput, type Outcome, type Question } from "../approvals";

export const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";
export const PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
export const USER_INPUT = "item/tool/requestUserInput";
export const MCP_ELICITATION = "mcpServer/elicitation/request";
export const REQUEST_RESOLVED = "serverRequest/resolved";

type Decided = Extract<Outcome, { type: "decided" }>;

/** A request that waits for a person. `answer` is the JSON-RPC result Codex waits for. */
export interface AskedRequest {
  type: "ask";
  payload(requestId: string): Record<string, unknown>;
  answer(outcome: Decided | { type: "expired" }): unknown;
}

/** A request Draft cannot show. Codex gets this result at once, and viewers get the note. */
export interface DeclinedRequest {
  type: "decline";
  result: unknown;
  note: string;
}

type Params = Record<string, unknown>;

const asRecord = (value: unknown): Params => (value && typeof value === "object" && !Array.isArray(value) ? (value as Params) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The questions Codex's request_user_input asked, in the shape the chat shows. A question without options takes typed text. */
export function questionsFromParams(params: Params): Question[] {
  const raw = Array.isArray(params.questions) ? params.questions : [];
  const questions: Question[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    const id = text(q.id);
    const question = text(q.question);
    if (!id || !question) continue;
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((option) => {
      const o = asRecord(option);
      const label = text(o.label);
      return label ? [{ label, ...(text(o.description) ? { description: text(o.description)! } : {}) }] : [];
    });
    questions.push({
      key: id,
      ...(text(q.header) ? { header: text(q.header)! } : {}),
      question,
      options,
      multiSelect: false,
      isOther: q.isOther === true || options.length === 0,
      isSecret: q.isSecret === true,
    });
  }
  return questions;
}

const base = (requestId: string, name: string, kind: "approval" | "question", input: unknown) => ({ requestId, name, kind, ...summarizeToolInput(input) });

function commandOrFile(method: string, params: Params): AskedRequest {
  const command = method === COMMAND_APPROVAL;
  const input = command ? { command: params.command ?? null, cwd: params.cwd ?? null, reason: params.reason ?? null } : { reason: params.reason ?? null, grantRoot: params.grantRoot ?? null };
  return {
    type: "ask",
    payload: (requestId) => ({ ...base(requestId, command ? "command" : "file_change", "approval", input), allowSession: true }),
    answer: (outcome) => ({ decision: outcome.type !== "decided" ? "cancel" : outcome.decision === "deny" ? "decline" : outcome.extras.scope === "session" ? "acceptForSession" : "accept" }),
  };
}

function permissions(params: Params): AskedRequest {
  const requested = asRecord(params.permissions);
  const input = { reason: params.reason ?? null, cwd: params.cwd ?? null, permissions: requested };
  return {
    type: "ask",
    payload: (requestId) => ({ ...base(requestId, "permissions", "approval", input), allowSession: true }),
    answer: (outcome) =>
      outcome.type === "decided" && outcome.decision === "allow"
        ? { permissions: requested, scope: outcome.extras.scope === "session" ? "session" : "turn" }
        : { permissions: {}, scope: "turn" },
  };
}

function userInput(params: Params): AskedRequest | DeclinedRequest {
  const questions = questionsFromParams(params);
  if (questions.length === 0) return { type: "decline", result: { answers: {} }, note: "Codex asked a question Draft could not show." };
  return {
    type: "ask",
    payload: (requestId) => ({ ...base(requestId, "request_user_input", "question", { questions: params.questions }), questions }),
    answer: (outcome) => {
      const answers: Record<string, { answers: string[] }> = {};
      if (outcome.type === "decided" && outcome.decision === "allow") {
        for (const [key, value] of Object.entries(cleanAnswers(outcome.extras.answers, questions))) answers[key] = { answers: [value].flat() };
      }
      return { answers };
    },
  };
}

function elicitation(params: Params): AskedRequest | DeclinedRequest {
  const server = text(params.serverName) ?? "An MCP server";
  const schema = asRecord(params.requestedSchema);
  if (params.mode === "form" && Object.keys(asRecord(schema.properties)).length > 0) {
    return { type: "decline", result: { action: "decline", content: null }, note: `${server} asked for details in a form. Draft cannot show forms yet, so it was declined.` };
  }
  const input = { server, message: params.message ?? null, url: params.url ?? null };
  return {
    type: "ask",
    payload: (requestId) => base(requestId, "mcp_elicitation", "approval", input),
    answer: (outcome) => ({ action: outcome.type !== "decided" ? "cancel" : outcome.decision === "deny" ? "decline" : "accept", content: outcome.type === "decided" && outcome.decision === "allow" && params.mode === "form" ? {} : null }),
  };
}

/** What Draft does with one server request from Codex, or null for a request it does not know. */
export function codexRequest(method: string, params: unknown): AskedRequest | DeclinedRequest | null {
  const p = asRecord(params);
  switch (method) {
    case COMMAND_APPROVAL:
    case FILE_CHANGE_APPROVAL:
      return commandOrFile(method, p);
    case PERMISSIONS_APPROVAL:
      return permissions(p);
    case USER_INPUT:
      return userInput(p);
    case MCP_ELICITATION:
      return elicitation(p);
    default:
      return null;
  }
}
