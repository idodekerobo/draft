import { beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
const WS = "11111111-1111-4111-8111-111111111111";
let accessResult: Response | null = null;
let uploadError: Error | null = null;
const uploadPaths: Array<{ path: string; options: unknown }> = [];

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => accessResult }));
mock.module("../../db/client", () => ({
  serviceClient: {
    from: () => ({ insert: async () => ({ data: null, error: null }) }),
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path: string, options: unknown) => {
          uploadPaths.push({ path, options });
          if (uploadError) return { data: null, error: uploadError };
          return { data: { signedUrl: `https://storage.test/upload/${path}?token=t` }, error: null };
        },
      }),
    },
  },
}));

const routes = await import("../../routes/sessions-live-seed");

function request() {
  return Object.assign(new Request(`http://localhost/workspaces/${WS}/live-sessions/seed-upload`, { method: "POST" }), { params: { id: WS } }) as never;
}

beforeEach(() => {
  accessResult = null;
  uploadError = null;
  uploadPaths.length = 0;
});

describe("SEED_UPLOAD", () => {
  it("makes a session id and a signed upload link under that session's snapshot key", async () => {
    const res = await routes.SEED_UPLOAD(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; sessionId: string; storageKey: string; signedUrl: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.storageKey).toBe(`${WS}/${body.sessionId}/seed.tar.gz`);
    expect(body.signedUrl).toBe(`https://storage.test/upload/${body.storageKey}?token=t`);
    expect(uploadPaths).toEqual([{ path: body.storageKey, options: { upsert: true } }]);
  });

  it("gives each call its own session id", async () => {
    const first = (await (await routes.SEED_UPLOAD(request())).json()) as { sessionId: string };
    const second = (await (await routes.SEED_UPLOAD(request())).json()) as { sessionId: string };
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("refuses a caller who is not a member of the workspace, and makes no link", async () => {
    accessResult = Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    const res = await routes.SEED_UPLOAD(request());
    expect(res.status).toBe(403);
    expect(uploadPaths).toEqual([]);
  });

  it("returns 500 when the upload link cannot be signed", async () => {
    uploadError = new Error("storage down");
    const res = await routes.SEED_UPLOAD(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "seed_upload_url_failed" });
  });
});
