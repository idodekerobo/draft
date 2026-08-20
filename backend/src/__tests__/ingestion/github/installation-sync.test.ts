import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
} from "../../../ingestion/github/installation-sync";

function createFakeClient(connection: { id: string; config_json: Record<string, unknown> } | null) {
  const updateCalls: Record<string, unknown>[] = [];

  function from(table: string) {
    if (table !== "source_connections") throw new Error(`Unexpected table: ${table}`);
    return {
      update: (payload: Record<string, unknown>) => {
        updateCalls.push(payload);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: connection, error: null }) }) }),
      }),
    };
  }

  return { client: { from } as unknown as SupabaseClient, updateCalls };
}

describe("handleInstallationEvent", () => {
  it.each([
    ["deleted", "revoked"],
    ["suspend", "degraded"],
    ["unsuspend", "active"],
  ] as const)("maps action %s to status %s", async (action, status) => {
    const { client, updateCalls } = createFakeClient(null);
    await handleInstallationEvent({ action, installation: { id: 123 } }, client);
    expect(updateCalls).toEqual([{ status }]);
  });

  it.each(["created", "new_permissions_accepted"])("is a no-op for %s", async (action) => {
    const { client, updateCalls } = createFakeClient(null);
    await handleInstallationEvent({ action, installation: { id: 123 } }, client);
    expect(updateCalls).toHaveLength(0);
  });
});

describe("handleInstallationRepositoriesEvent", () => {
  it("adds and removes repos from config_json.repos", async () => {
    const { client, updateCalls } = createFakeClient({
      id: "conn-1",
      config_json: { repos: ["acme/keep", "acme/drop"] },
    });

    await handleInstallationRepositoriesEvent(
      {
        action: "added",
        installation: { id: 123 },
        repositories_added: [{ full_name: "acme/new" }],
        repositories_removed: [{ full_name: "acme/drop" }],
      },
      client,
    );

    const repos = (updateCalls[0]?.config_json as Record<string, unknown>).repos as string[];
    expect(new Set(repos)).toEqual(new Set(["acme/keep", "acme/new"]));
  });

  it("is a no-op when no connection matches the installation", async () => {
    const { client } = createFakeClient(null);
    await expect(
      handleInstallationRepositoriesEvent(
        { action: "added", installation: { id: 123 }, repositories_added: [{ full_name: "acme/new" }] },
        client,
      ),
    ).resolves.toBeUndefined();
  });
});
