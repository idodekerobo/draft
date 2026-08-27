import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadValidatedRunBundle } from "../../synthesis/load-run-bundle";
import { canonicalDocumentsHash } from "../../synthesis/context-version-files";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const ids = {
  org: "11111111-1111-4111-8111-111111111111",
  team: "22222222-2222-4222-8222-222222222222",
  workspace: "33333333-3333-4333-8333-333333333333",
  version: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  sourceA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

/**
 * Fake Supabase client whose "source_items" table has no .in() method at
 * all -- any query still shaped as .in("id", ids) throws, which is what
 * caught this regression (the URL-length "Bad Request" was invisible to
 * unit tests that stub .in() to just work).
 */
function createFakeClient() {
  const contentA = "hello from source A";
  const sourceItemsTable = [
    {
      id: ids.sourceA,
      workspace_id: ids.workspace,
      external_version: "ext-a",
      content_markdown: contentA,
      content_hash: sha256(contentA),
    },
    // Belongs to the same workspace but isn't referenced by any membership --
    // proves the fetch is scoped by workspace_id, not by the membership id list.
    {
      id: ids.sourceB,
      workspace_id: ids.workspace,
      external_version: "ext-b",
      content_markdown: "unrelated source",
      content_hash: sha256("unrelated source"),
    },
  ];

  function from(table: string) {
    if (table === "synthesis_runs") {
      return {
        select: () => ({
          order: () => ({
            eq: () => ({
              limit: () => ({
                single: async () => ({
                  data: {
                    id: ids.run,
                    workspace_id: ids.workspace,
                    base_context_version_id: ids.version,
                    prompt_version: "synthesis-v1",
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === "workspaces") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { id: ids.workspace, organization_id: ids.org, team_id: ids.team },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "workspace_context_versions") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: ids.version,
                workspace_id: ids.workspace,
                documents_json: {},
                content_hash: canonicalDocumentsHash({}),
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "synthesis_run_source_items") {
      return {
        select: () => ({
          eq: () => ({
            order: async () => ({
              data: [
                {
                  workspace_id: ids.workspace,
                  synthesis_run_id: ids.run,
                  source_item_id: ids.sourceA,
                  source_item_version: "ext-a",
                  content_hash: sha256(contentA),
                  position: 0,
                },
              ],
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "source_items") {
      return {
        select: () => ({
          eq: (column: string, value: string) => {
            if (column !== "workspace_id" || value !== ids.workspace) {
              throw new Error(`unexpected filter on source_items: ${column}=${value}`);
            }
            return Promise.resolve({ data: sourceItemsTable, error: null });
          },
        }),
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { from } as unknown as SupabaseClient;
}

describe("loadValidatedRunBundle", () => {
  it("resolves source items by workspace_id instead of an .in() id list", async () => {
    const client = createFakeClient();
    const bundle = await loadValidatedRunBundle({ runId: ids.run, client });
    expect(bundle.runId).toBe(ids.run);
    expect(Object.keys(bundle.files)).toContain("input/sources/0000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.md");
  });
});
