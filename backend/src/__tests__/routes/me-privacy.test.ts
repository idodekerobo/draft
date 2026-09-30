import { beforeEach, describe, expect, it, mock } from "bun:test";

type Row = { analytics_consent: boolean | null; analytics_consent_at: string | null; session_replay_enabled: boolean };
let row: Row;
let updateError: { message: string } | null = null;
let recordedErrors: Array<Record<string, unknown>> = [];

function createFakeClient() {
  return {
    rpc: () => ({ maybeSingle: async () => ({ data: { workspace_id: "workspace-1" }, error: null }) }),
    from(table: string) {
      if (table === "errors") return { insert: async (payload: Record<string, unknown>) => { recordedErrors.push(payload); return { error: null }; } };
      let update: Partial<Row> | null = null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        update: (next: Partial<Row>) => { update = next; return builder; },
        single: async () => {
          if (update && updateError) return { data: null, error: updateError };
          if (update) row = { ...row, ...update };
          return { data: { ...row }, error: null };
        },
      };
      return builder;
    },
  };
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (req: Request, caller: { userId: string }) => Response | Promise<Response>) =>
    (req: Request) => handler(req, { userId: "caller-1" }),
}));
mock.module("../../db/client", () => ({ serviceClient: createFakeClient() }));

const { PATCH } = await import("../../routes/me-privacy");

function patch(body: unknown): Promise<Response> {
  return Promise.resolve(PATCH(new Request("http://internal.test/me/privacy", { method: "PATCH", body: JSON.stringify(body) })));
}

describe("PATCH /me/privacy", () => {
  beforeEach(() => {
    row = { analytics_consent: null, analytics_consent_at: null, session_replay_enabled: false };
    updateError = null;
    recordedErrors = [];
  });

  it("records a failed update", async () => {
    updateError = { message: "db down" };
    expect((await patch({ analytics_consent: true })).status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recordedErrors).toHaveLength(1);
    expect(recordedErrors[0]).toMatchObject({ workspace_id: "workspace-1", operation: "commit" });
    expect((recordedErrors[0]!.detail_json as { code: string }).code).toBe("privacy_update_failed");
  });

  it("rejects replay without consent", async () => {
    const response = await patch({ session_replay_enabled: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "replay_requires_consent" });
  });

  it("sets consent_at on grant and on withdrawal, and withdrawal turns replay off", async () => {
    const granted = await (await patch({ analytics_consent: true, session_replay_enabled: true })).json() as Row;
    expect(granted.analytics_consent).toBe(true);
    expect(granted.session_replay_enabled).toBe(true);
    expect(granted.analytics_consent_at).not.toBeNull();

    row.analytics_consent_at = "earlier";
    const withdrawn = await (await patch({ analytics_consent: false })).json() as Row;
    expect(withdrawn.analytics_consent).toBe(false);
    expect(withdrawn.session_replay_enabled).toBe(false);
    expect(withdrawn.analytics_consent_at).not.toBe("earlier");
  });

  it("changes replay alone without touching consent_at", async () => {
    row = { analytics_consent: true, analytics_consent_at: "t0", session_replay_enabled: false };
    const body = await (await patch({ session_replay_enabled: true })).json() as Row;
    expect(body).toEqual({ analytics_consent: true, analytics_consent_at: "t0", session_replay_enabled: true });
  });

  it.each([{}, { analytics_consent: "yes" }, { other: true }, null])("rejects invalid body %j", async (body) => {
    expect((await patch(body)).status).toBe(400);
  });
});
