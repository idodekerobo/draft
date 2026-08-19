import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { randomBytes } from "node:crypto";

const caller = { userId: "user-1", accessToken: "token-1" };
const workspaceId = "workspace-1";

interface CredentialRow {
  id: string;
  workspace_id: string;
  provider: string;
  label: string | null;
  status: string;
}

const state: { credentials: CredentialRow[] } = { credentials: [] };
let nextId = 0;

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

function createFakeClient() {
  return {
    from(table: string) {
      if (table !== "credentials") throw new Error(`Unexpected table: ${table}`);
      return {
        insert(payload: Partial<CredentialRow> & { encrypted_payload: unknown; encryption_key_version: string }) {
          const row: CredentialRow = {
            id: `cred-${++nextId}`,
            workspace_id: payload.workspace_id!,
            provider: payload.provider!,
            label: payload.label ?? null,
            status: payload.status ?? "active",
          };
          state.credentials.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: row.id }, error: null }),
            }),
          };
        },
      };
    },
  };
}

let accessResult: Response | null = null;

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({ serviceClient: createFakeClient() }));

const routeModule = await import("../../routes/session-tokens");

beforeEach(() => {
  accessResult = null;
  state.credentials = [];
});

function request(body?: unknown): Request {
  return Object.assign(
    new Request("https://internal.test", {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: { id: workspaceId } },
  );
}

describe("POST /workspaces/:id/sessions/tokens", () => {
  it("mints a token once, formatted draft_sit_<credentialId>_<secret>", async () => {
    const response = await routeModule.POST(request({ label: "my-repo" }) as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; token: string };
    expect(body.id).toBe(state.credentials[0]?.id);
    expect(body.token.startsWith(`draft_sit_${body.id}_`)).toBe(true);
    expect(state.credentials[0]?.provider).toBe("claude_session_ingest");
    expect(state.credentials[0]?.label).toBe("my-repo");
    expect(state.credentials[0]?.status).toBe("active");
  });

  it("mints without a label", async () => {
    const response = await routeModule.POST(request(undefined) as never);
    expect(response.status).toBe(200);
    expect(state.credentials[0]?.label).toBeNull();
  });

  it("rejects an invalid body", async () => {
    const response = await routeModule.POST(request({ label: 123 }) as never);
    expect(response.status).toBe(400);
  });

  it("returns the workspace access denial before minting", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });
    const response = await routeModule.POST(request({}) as never);
    expect(response.status).toBe(403);
    expect(state.credentials).toHaveLength(0);
  });
});
