import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let queryResult: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
};

function queryBuilder() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => queryResult,
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
  serviceClient: { from: () => queryBuilder() },
}));

const routeModule = await import("../../routes/workspace-context");

function request(params: Record<string, string>): Request {
  // documentGET derives the wildcard-captured path from the URL itself
  // (Bun does not expose "*" via req.params), so the fake request's URL
  // must actually match "/workspaces/:id/context/documents/<*>" for those
  // tests to exercise the same code path a real request would.
  const wildcard = params["*"];
  const url = wildcard !== undefined
    ? `http://internal.test/workspaces/${params.id}/context/documents/${wildcard.split("/").map(encodeURIComponent).join("/")}`
    : "http://internal.test";
  return Object.assign(new Request(url), { params });
}

describe("workspace context routes", () => {
  beforeEach(() => {
    accessResult = null;
    queryResult = { data: null, error: null };
  });

  it("returns the latest context manifest after access is granted", async () => {
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
      paths: ["product/index.md", "product/log/20260806_note.md"],
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

  it("returns a document from the latest version", async () => {
    queryResult = {
      data: {
        documents_json: {
          "product/log/20260806_note.md": { content: "note", sha256: "sha-note" },
        },
      },
      error: null,
    };

    const response = await routeModule.documentGET(
      request({ id: "workspace-1", "*": "product/log/20260806_note.md" }) as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "product/log/20260806_note.md",
      content: "note",
      sha256: "sha-note",
    });
  });

  it("returns not_found for a missing document", async () => {
    queryResult = { data: { documents_json: {} }, error: null };

    const response = await routeModule.documentGET(
      request({ id: "workspace-1", "*": "product/missing.md" }) as never,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it.each(["../../etc/passwd", "/absolute.md", "product/data.json"])(
    "rejects unsafe document path %s",
    async (path) => {
      const response = await routeModule.documentGET(
        request({ id: "workspace-1", "*": path }) as never,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_path" });
    },
  );
});
