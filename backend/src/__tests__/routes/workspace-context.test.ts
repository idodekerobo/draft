import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let queryResult: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
};
let workspaceTimezone = "UTC";

function contextVersionQueryBuilder() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => queryResult,
  };
  return builder;
}

function workspaceQueryBuilder() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    single: async () => ({ data: { timezone: workspaceTimezone }, error: null }),
  };
  return builder;
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({
  serviceClient: {
    from: (table: string) =>
      table === "workspaces" ? workspaceQueryBuilder() : contextVersionQueryBuilder(),
  },
}));

const routeModule = await import("../../routes/workspace-context");

function request(params: Record<string, string>, query?: Record<string, string>): Request {
  const url = new URL("http://internal.test");
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return Object.assign(new Request(url), { params });
}

describe("workspace context routes", () => {
  beforeEach(() => {
    accessResult = null;
    queryResult = { data: null, error: null };
    workspaceTimezone = "UTC";
  });

  it("returns the latest context snapshot after access is granted", async () => {
    queryResult = {
      data: {
        id: "version-2",
        version_number: 2,
        content_hash: "hash-2",
        creation_reason: "synthesis",
        created_at: "2026-08-06T00:00:00.000Z",
        documents_json: {
          "product/index.md": { content: "product", sha256: "sha-product" },
          "product/log/20260806_note.md": { content: "note", sha256: "sha-note" },
        },
      },
      error: null,
    };

    const response = await routeModule.contextGET(request({ id: "workspace-1" }) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      versionId: "version-2",
      versionNumber: 2,
      contentHash: "hash-2",
      creationReason: "synthesis",
      createdAt: "2026-08-06T00:00:00.000Z",
      documents: {
        "product/index.md": { content: "product", sha256: "sha-product" },
        "product/log/20260806_note.md": { content: "note", sha256: "sha-note" },
      },
    });
  });

  it("returns an access denial without querying context", async () => {
    accessResult = Response.json({ error: "forbidden" }, { status: 403 });

    const response = await routeModule.contextGET(request({ id: "workspace-1" }) as never);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("returns no_context_yet when a workspace has no version", async () => {
    const response = await routeModule.contextGET(request({ id: "workspace-1" }) as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no_context_yet" });
  });

  it("narrows to a single memory period document when ?period= is given", async () => {
    queryResult = {
      data: {
        id: "version-2",
        version_number: 2,
        content_hash: "hash-2",
        creation_reason: "synthesis",
        created_at: "2026-08-06T00:00:00.000Z",
        documents_json: {
          "product/index.md": { content: "product", sha256: "sha-product" },
          "memory/index.md": { content: "memory", sha256: "sha-memory" },
          "memory/days/2026-09-16.md": { content: "day content", sha256: "sha-day" },
        },
      },
      error: null,
    };

    const response = await routeModule.contextGET(
      request({ id: "workspace-1" }, { period: "2026-09-16" }) as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.documents).toEqual({
      "memory/days/2026-09-16.md": { content: "day content", sha256: "sha-day" },
    });
  });

  it("returns period_not_found when the resolved period document doesn't exist", async () => {
    queryResult = {
      data: {
        id: "version-2",
        version_number: 2,
        content_hash: "hash-2",
        creation_reason: "synthesis",
        created_at: "2026-08-06T00:00:00.000Z",
        documents_json: { "memory/index.md": { content: "memory", sha256: "sha-memory" } },
      },
      error: null,
    };

    const response = await routeModule.contextGET(
      request({ id: "workspace-1" }, { period: "2020-01-01" }) as never,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "period_not_found" });
  });

  it("rejects ?period= combined with a non-memory ?dimension=", async () => {
    queryResult = {
      data: {
        id: "version-2",
        version_number: 2,
        content_hash: "hash-2",
        creation_reason: "synthesis",
        created_at: "2026-08-06T00:00:00.000Z",
        documents_json: {},
      },
      error: null,
    };

    const response = await routeModule.contextGET(
      request({ id: "workspace-1" }, { period: "today", dimension: "product" }) as never,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("does not support periods");
  });
});
