import { describe, expect, it } from "bun:test";
import { COMMAND_APPROVAL, FILE_CHANGE_APPROVAL, MCP_ELICITATION, PERMISSIONS_APPROVAL, USER_INPUT, codexRequest, questionsFromParams, type AskedRequest } from "./approvals";

const by = { userId: "u1", name: "Dev" };
const allow = (extras = {}) => ({ type: "decided" as const, decision: "allow" as const, by, extras });
const deny = (extras = {}) => ({ type: "decided" as const, decision: "deny" as const, by, extras });
const ask = (method: string, params: unknown) => {
  const request = codexRequest(method, params);
  if (!request || request.type !== "ask") throw new Error("not an ask");
  return request as AskedRequest;
};

describe("command and file approvals", () => {
  it("show the command and where it runs, and offer Allow for session", () => {
    expect(ask(COMMAND_APPROVAL, { command: "touch a", cwd: "/p", reason: "May I?" }).payload("r1")).toMatchObject({
      requestId: "r1", name: "command", kind: "approval", input: { command: "touch a", cwd: "/p", reason: "May I?" }, allowSession: true,
    });
    expect(ask(FILE_CHANGE_APPROVAL, { reason: "write", grantRoot: "/p" }).payload("r1")).toMatchObject({ name: "file_change" });
  });

  it("answer accept, accept for the session, decline, and cancel when nobody answered", () => {
    const request = ask(COMMAND_APPROVAL, { command: "ls" });
    expect(request.answer(allow())).toEqual({ decision: "accept" });
    expect(request.answer(allow({ scope: "session" }))).toEqual({ decision: "acceptForSession" });
    expect(request.answer(deny({ message: "no" }))).toEqual({ decision: "decline" });
    expect(request.answer({ type: "expired" })).toEqual({ decision: "cancel" });
  });
});

describe("request_user_input", () => {
  const params = {
    questions: [
      { id: "area", header: "Area", question: "Which area?", options: [{ label: "Auth", description: "login" }, { label: "Billing", description: "" }], isOther: false, isSecret: false },
      { id: "note", header: "Note", question: "Anything else?", options: null, isOther: false, isSecret: true },
    ],
    isBlocking: true,
  };

  it("shows the questions by id, and takes typed text when a question has no options", () => {
    expect(questionsFromParams(params)).toEqual([
      { key: "area", header: "Area", question: "Which area?", options: [{ label: "Auth", description: "login" }, { label: "Billing" }], multiSelect: false, isOther: false, isSecret: false },
      { key: "note", header: "Note", question: "Anything else?", options: [], multiSelect: false, isOther: true, isSecret: true },
    ]);
    expect(ask(USER_INPUT, params).payload("r1")).toMatchObject({ kind: "question", name: "request_user_input" });
  });

  it("answers by question id, from answers sent by position or by id", () => {
    const request = ask(USER_INPUT, params);
    expect(request.answer(allow({ answers: { "0": "Auth", "1": "hello" } }))).toEqual({ answers: { area: { answers: ["Auth"] }, note: { answers: ["hello"] } } });
    expect(request.answer(allow({ answers: { area: "Billing" } }))).toEqual({ answers: { area: { answers: ["Billing"] } } });
    expect(request.answer(deny())).toEqual({ answers: {} });
  });

  it("answers an unreadable question at once instead of waiting", () => {
    expect(codexRequest(USER_INPUT, { questions: [] })).toMatchObject({ type: "decline", result: { answers: {} } });
  });
});

describe("permissions", () => {
  const requested = { fileSystem: { write: ["/tmp"] }, network: null };

  it("grants what was asked for the turn or the session, and nothing when denied", () => {
    const request = ask(PERMISSIONS_APPROVAL, { permissions: requested, reason: "need tmp", cwd: "/p" });
    expect(request.payload("r1")).toMatchObject({ name: "permissions", kind: "approval", input: { reason: "need tmp", permissions: requested } });
    expect(request.answer(allow())).toEqual({ permissions: requested, scope: "turn" });
    expect(request.answer(allow({ scope: "session" }))).toEqual({ permissions: requested, scope: "session" });
    expect(request.answer(deny())).toEqual({ permissions: {}, scope: "turn" });
    expect(request.answer({ type: "expired" })).toEqual({ permissions: {}, scope: "turn" });
  });
});

describe("MCP elicitation", () => {
  it("asks to accept or decline a link or a confirmation", () => {
    const request = ask(MCP_ELICITATION, { serverName: "github", mode: "url", message: "Sign in", url: "https://x.test", elicitationId: "e" });
    expect(request.payload("r1")).toMatchObject({ name: "mcp_elicitation", input: { server: "github", url: "https://x.test" } });
    expect(request.answer(allow())).toEqual({ action: "accept", content: null });
    expect(request.answer(deny())).toEqual({ action: "decline", content: null });
    expect(request.answer({ type: "expired" })).toEqual({ action: "cancel", content: null });
  });

  it("declines a form with fields at once and says so", () => {
    const form = codexRequest(MCP_ELICITATION, { serverName: "github", mode: "form", message: "Details", requestedSchema: { type: "object", properties: { repo: { type: "string" } } } });
    expect(form).toMatchObject({ type: "decline", result: { action: "decline", content: null } });
    expect((form as { note: string }).note).toContain("github");
  });
});

describe("codexRequest", () => {
  it("is null for a request Draft does not know", () => {
    expect(codexRequest("item/tool/call", {})).toBeNull();
  });
});
