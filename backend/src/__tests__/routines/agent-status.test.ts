import { describe, expect, it } from "bun:test";
import { routineAgentProblem, routineAgentStatuses } from "../../routines/agent-status";
import { fakeClient, fakeDb } from "./fake-client";

const WS = "ws-1";

function db(rows: { claude?: string | null; codex?: string | null } = {}) {
  const credentials: Array<Record<string, unknown>> = [];
  if (rows.claude) credentials.push({ id: "c-claude", workspace_id: WS, provider: "claude_code", status: rows.claude });
  if (rows.codex) credentials.push({ id: "c-codex", workspace_id: WS, provider: "codex_chatgpt_auth", status: rows.codex });
  return fakeClient(fakeDb({ workspaces: [{ id: WS, inference_credential_id: rows.claude ? "c-claude" : null }], credentials }));
}

describe("routineAgentStatuses", () => {
  it("is not connected for an agent with no login", async () => {
    expect(await routineAgentStatuses(db(), WS)).toEqual({ claude: "not_connected", codex: "not_connected" });
  });

  it("is connected for an active login, and needs a new sign-in for one that stopped working", async () => {
    expect(await routineAgentStatuses(db({ claude: "active", codex: "active" }), WS)).toEqual({ claude: "connected", codex: "connected" });
    expect(await routineAgentStatuses(db({ claude: "revoked", codex: "expired" }), WS)).toEqual({ claude: "needs_reconnect", codex: "needs_reconnect" });
  });

  it("tells the two agents apart", async () => {
    expect(await routineAgentStatuses(db({ codex: "active" }), WS)).toEqual({ claude: "not_connected", codex: "connected" });
  });
});

describe("routineAgentProblem", () => {
  it("lets a routine use an agent with an active login", async () => {
    expect(await routineAgentProblem(db({ claude: "active", codex: "active" }), WS, "claude")).toBeNull();
    expect(await routineAgentProblem(db({ claude: "active", codex: "active" }), WS, "codex")).toBeNull();
  });

  it("refuses Claude with no token, saying why and how to fix it", async () => {
    const problem = await routineAgentProblem(db({ codex: "active" }), WS, "claude");
    expect(problem?.code).toBe("claude_not_connected");
    expect(problem?.message).toContain("Claude Code isn't connected for routines in this workspace");
    expect(problem?.message).toContain("claude setup-token");
    expect(problem?.message).toContain("routines.options");
  });

  it("tells a login that stopped working apart from one that was never made", async () => {
    expect((await routineAgentProblem(db({ codex: "revoked" }), WS, "codex"))?.code).toBe("codex_needs_reconnect");
    expect((await routineAgentProblem(db(), WS, "codex"))?.code).toBe("codex_not_connected");
  });
});
