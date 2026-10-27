import { beforeEach, describe, expect, it, mock } from "bun:test";

type Row = Record<string, unknown>;
let user: Row | null = { organization_id: "org-1", primary_team_id: "team-1" };
let activeInvite: Row | null = null;
let inserted: Row[] = [];

function builder(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gt: () => chain,
    order: () => chain,
    limit: () => chain,
    insert: async (row: Row) => {
      inserted.push(row);
      return { error: null };
    },
    async maybeSingle() {
      return { data: table === "users" ? user : activeInvite, error: null };
    },
  };
  return chain;
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, caller: { userId: string }) => unknown) => (request: Request) => handler(request, { userId: "user-1" }),
}));
mock.module("../../db/client", () => ({ serviceClient: { from: (table: string) => builder(table) } }));
mock.module("../../config", () => ({ loadConfig: () => ({ appUrl: "https://app.example.test" }) }));

const { mineGET } = await import("../../auth/invite-routes");

const call = (query = "") => mineGET(Object.assign(new Request(`http://localhost/invites/mine${query}`), { params: {} }) as never);

beforeEach(() => {
  user = { organization_id: "org-1", primary_team_id: "team-1" };
  activeInvite = null;
  inserted = [];
});

describe("GET /invites/mine", () => {
  it("returns the active link and creates nothing", async () => {
    activeInvite = { token: "tok", expires_at: "2026-12-01T00:00:00Z" };
    const body = (await (await call()).json()) as { url: string };
    expect(body.url).toBe("https://app.example.test/invite/tok");
    expect(inserted).toEqual([]);
  });

  it("creates a link when none is active", async () => {
    const body = (await (await call()).json()) as { url: string };
    expect(body.url).toStartWith("https://app.example.test/invite/");
    expect(inserted.length).toBe(1);
    expect(inserted[0]).toMatchObject({ organization_id: "org-1", team_id: "team-1" });
  });

  it("only looks when create=false: no link means null and nothing is created", async () => {
    const body = await (await call("?create=false")).json();
    expect(body).toEqual({ url: null, expiresAt: null });
    expect(inserted).toEqual([]);
  });

  it("create=false still returns an active link", async () => {
    activeInvite = { token: "tok", expires_at: "2026-12-01T00:00:00Z" };
    const body = (await (await call("?create=false")).json()) as { url: string };
    expect(body.url).toBe("https://app.example.test/invite/tok");
  });

  it("a user with no team gets 404", async () => {
    user = { organization_id: null, primary_team_id: null };
    expect((await call()).status).toBe(404);
  });
});
