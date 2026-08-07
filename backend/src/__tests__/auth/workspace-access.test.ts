import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

interface FakeClientOptions {
  user?: { id: string; organization_id: string | null; primary_team_id: string | null } | null;
  workspace?: { organization_id: string; team_id: string; access_mode: string } | null;
  userError?: { message: string } | null;
  workspaceError?: { message: string } | null;
}

let options: FakeClientOptions;

function createFakeClient() {
  return {
    from(table: string) {
      if (table === "users") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: options.user ?? null,
                    error: options.userError ?? null,
                  }),
                };
              },
            };
          },
        };
      }

      if (table === "workspaces") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: options.workspace ?? null,
                    error: options.workspaceError ?? null,
                  }),
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const fakeClient = createFakeClient();
mock.module("../../db/client", () => ({ serviceClient: fakeClient }));
const { assertWorkspaceAccess } = await import("../../auth/workspace-access");

const ids = {
  caller: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  team: "33333333-3333-4333-8333-333333333333",
  workspace: "44444444-4444-4444-8444-444444444444",
};

function validOptions(overrides: Partial<FakeClientOptions> = {}): FakeClientOptions {
  return {
    user: {
      id: ids.caller,
      organization_id: ids.organization,
      primary_team_id: ids.team,
    },
    workspace: {
      organization_id: ids.organization,
      team_id: ids.team,
      access_mode: "team_default",
    },
    ...overrides,
  };
}

async function responseBody(response: Response): Promise<{ error: string }> {
  return (await response.json()) as { error: string };
}

describe("assertWorkspaceAccess", () => {
  it("allows a matching team_default workspace", async () => {
    options = validOptions();
    expect(await assertWorkspaceAccess(ids.workspace, ids.caller)).toBeNull();
  });

  it("denies a workspace from another organization", async () => {
    options = validOptions({
      workspace: {
        organization_id: "different-org",
        team_id: ids.team,
        access_mode: "team_default",
      },
    });
    const response = await assertWorkspaceAccess(ids.workspace, ids.caller);
    expect(response?.status).toBe(403);
    expect(await responseBody(response!)).toEqual({ error: "forbidden" });
  });

  it("denies a workspace from another team", async () => {
    options = validOptions({
      workspace: {
        organization_id: ids.organization,
        team_id: "different-team",
        access_mode: "team_default",
      },
    });
    expect((await assertWorkspaceAccess(ids.workspace, ids.caller))?.status).toBe(403);
  });

  it("denies restricted workspaces", async () => {
    options = validOptions({
      workspace: {
        organization_id: ids.organization,
        team_id: ids.team,
        access_mode: "restricted",
      },
    });
    expect((await assertWorkspaceAccess(ids.workspace, ids.caller))?.status).toBe(403);
  });

  it("returns 404 when the caller has no team", async () => {
    options = validOptions({
      user: { id: ids.caller, organization_id: ids.organization, primary_team_id: null },
    });
    const response = await assertWorkspaceAccess(ids.workspace, ids.caller);
    expect(response?.status).toBe(404);
    expect(await responseBody(response!)).toEqual({ error: "no_team" });
  });

  it("returns 404 for a nonexistent workspace", async () => {
    options = validOptions({ workspace: null });
    const response = await assertWorkspaceAccess(ids.workspace, ids.caller);
    expect(response?.status).toBe(404);
    expect(await responseBody(response!)).toEqual({ error: "not_found" });
  });
});
