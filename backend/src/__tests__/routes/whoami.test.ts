import { describe, expect, it, mock } from "bun:test";

interface LookupOptions {
  identity: Record<string, unknown> | null;
  identityError: { message: string } | null;
}

let options: LookupOptions = {
  identity: { id: "caller-1", workspace_id: "workspace-1" },
  identityError: null,
};

function createFakeClient() {
  return {
    rpc() {
      return {
        maybeSingle: async () => ({ data: options.identity, error: options.identityError }),
      };
    },
  };
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (req: Request, caller: { userId: string }) => Response | Promise<Response>) =>
    (req: Request) => handler(req, { userId: "caller-1" }),
}));
mock.module("../../db/client", () => ({ serviceClient: createFakeClient() }));

const { GET } = await import("../../routes/whoami");

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("GET /whoami", () => {
  it("returns the team_default workspace id", async () => {
    options = {
      identity: { id: "caller-1", workspace_id: "workspace-1" },
      identityError: null,
    };

    const response = await GET(new Request("http://internal.test/whoami"));
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(body.workspace_id).toBe("workspace-1");
  });

  it("returns null when the caller has no primary team", async () => {
    options = {
      identity: { id: "caller-1", primary_team_id: null, workspace_id: null },
      identityError: null,
    };

    const response = await GET(new Request("http://internal.test/whoami"));
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(body.workspace_id).toBeNull();
  });

  it("returns null when the team has no team_default workspace", async () => {
    options = {
      identity: { id: "caller-1", primary_team_id: "team-1", workspace_id: null },
      identityError: null,
    };

    const response = await GET(new Request("http://internal.test/whoami"));
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(body.workspace_id).toBeNull();
  });
});
