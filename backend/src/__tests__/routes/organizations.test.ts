import { beforeEach, describe, expect, it, mock } from "bun:test";

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

const CREATED = { organization_id: "org-1", team_id: "team-1", workspace_id: "workspace-1" };

let rpcResults: RpcResult[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let synthesisError: Error | null = null;
let synthesisCalls: Array<{ id: string }> = [];

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (req: Request, caller: { userId: string }) => Response | Promise<Response>) =>
    (req: Request) => handler(req, { userId: "caller-1" }),
}));
mock.module("../../db/client", () => ({
  serviceClient: {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return rpcResults.shift() ?? { data: null, error: { message: "unexpected_call" } };
    },
  },
}));
mock.module("../../synthesis/register-workspace-synthesis", () => ({
  createInitialWorkspaceSynthesis: async (workspace: { id: string }) => {
    synthesisCalls.push(workspace);
    if (synthesisError) throw synthesisError;
  },
}));

const { POST } = await import("../../routes/organizations");

function request(body: unknown): Request {
  return new Request("http://internal.test/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  rpcResults = [];
  rpcCalls = [];
  synthesisError = null;
  synthesisCalls = [];
});

describe("POST /organizations", () => {
  it("creates the organization and registers synthesis", async () => {
    rpcResults = [{ data: CREATED, error: null }];

    const response = await POST(request({ name: "  Acme Robotics  " }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ...CREATED, organization_name: "Acme Robotics" });
    expect(rpcCalls[0]?.args).toEqual({
      p_user_id: "caller-1",
      p_org_name: "Acme Robotics",
      p_org_slug: "acme-robotics",
      p_workspace_slug: "acme-robotics",
    });
    expect(synthesisCalls).toEqual([{ id: "workspace-1" }]);
  });

  it("rejects a missing, empty or oversized name", async () => {
    for (const body of [{}, { name: "   " }, { name: "x".repeat(81) }, "not json"]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns 409 when the caller already has an organization", async () => {
    rpcResults = [{ data: null, error: { code: "P0001", message: "already_in_organization" } }];

    const response = await POST(request({ name: "Acme" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_in_organization" });
    expect(synthesisCalls).toHaveLength(0);
  });

  it("retries with a suffixed slug when the slug is taken", async () => {
    rpcResults = [
      { data: null, error: { code: "23505", message: "duplicate key value" } },
      { data: CREATED, error: null },
    ];

    const response = await POST(request({ name: "Acme" }));

    expect(response.status).toBe(201);
    expect(rpcCalls[0]?.args.p_org_slug).toBe("acme");
    expect(rpcCalls[1]?.args.p_org_slug).toMatch(/^acme-[a-z0-9]{4}$/);
    expect(rpcCalls[1]?.args.p_workspace_slug).toBe("acme");
  });

  it("gives up after repeated slug collisions", async () => {
    rpcResults = Array.from({ length: 4 }, () => ({ data: null, error: { code: "23505", message: "duplicate key value" } }));

    const response = await POST(request({ name: "Acme" }));

    expect(response.status).toBe(500);
    expect(rpcCalls).toHaveLength(4);
  });

  it("returns 500 on an unexpected database error without retrying", async () => {
    rpcResults = [{ data: null, error: { code: "XX000", message: "boom" } }];

    const response = await POST(request({ name: "Acme" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "create_failed" });
    expect(rpcCalls).toHaveLength(1);
  });

  it("still returns 201 when synthesis registration fails", async () => {
    rpcResults = [{ data: CREATED, error: null }];
    synthesisError = new Error("scheduler down");

    const response = await POST(request({ name: "Acme" }));

    expect(response.status).toBe(201);
  });
});
