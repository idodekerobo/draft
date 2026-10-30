import { describe, expect, it } from "bun:test";
import { lacksRoutineLogin, routineAgentStatuses } from "../../routines/agent-status";
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

describe("lacksRoutineLogin", () => {
  it("holds a Codex routine to an active login", async () => {
    expect(await lacksRoutineLogin(db(), WS, "codex")).toBe(true);
    expect(await lacksRoutineLogin(db({ codex: "revoked" }), WS, "codex")).toBe(true);
    expect(await lacksRoutineLogin(db({ codex: "active" }), WS, "codex")).toBe(false);
  });

  it("does not hold a Claude routine to one, as before", async () => {
    expect(await lacksRoutineLogin(db(), WS, "claude")).toBe(false);
  });
});
