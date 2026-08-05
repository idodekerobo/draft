import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitSynthesisResult } from "../../synthesis/commit-result";
import type { ValidatedSynthesisResult } from "../../synthesis/types";
import { canonicalDocumentsHash } from "../../synthesis/context-version-files";

const ids = {
  workspace: "33333333-3333-4333-8333-333333333333",
  baseVersion: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  newVersion: "66666666-6666-4666-8666-666666666666",
};

interface FakeClientOptions {
  baseDocuments?: Record<string, { content: string; sha256: string }>;
  rpcResult?: { status: "committed" | "stale"; new_version_id: string | null };
}

/**
 * Fake Supabase client: `.from().select().eq().single()` for the run and
 * base-version reads, plus `.rpc()` recorded for assertions.
 */
function createFakeClient(options: FakeClientOptions = {}) {
  const calls: { rpcCalls: { fn: string; args: Record<string, unknown> }[] } = {
    rpcCalls: [],
  };

  const baseDocuments = options.baseDocuments ?? {
    "company/index.md": {
      content: "base content",
      sha256: "a".repeat(64),
    },
  };

  function from(table: string) {
    if (table === "synthesis_runs") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: ids.run,
                workspace_id: ids.workspace,
                base_context_version_id: ids.baseVersion,
              },
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
              data: { documents_json: baseDocuments },
              error: null,
            }),
          }),
        }),
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    calls.rpcCalls.push({ fn, args });
    return {
      data: options.rpcResult ?? { status: "committed", new_version_id: ids.newVersion },
      error: null,
    };
  }

  const client = { from, rpc } as unknown as SupabaseClient;
  return { client, calls };
}

function baseValidated(
  overrides: Partial<ValidatedSynthesisResult["payload"]> = {},
): ValidatedSynthesisResult {
  return {
    runId: ids.run,
    bundleHash: "bundle-hash",
    payload: {
      outcome: "changed",
      summary: "Updated company doc.",
      documents: { "company/index.md": "new content" },
      ...overrides,
    },
  };
}

describe("commitSynthesisResult", () => {
  it("computes the merged document set and calls the atomic RPC on 'changed'", async () => {
    const { client, calls } = createFakeClient();

    await commitSynthesisResult(baseValidated(), client);

    expect(calls.rpcCalls).toHaveLength(1);
    const call = calls.rpcCalls[0];
    expect(call.fn).toBe("commit_synthesis_run");
    expect(call.args.p_run_id).toBe(ids.run);
    expect(call.args.p_outcome).toBe("changed");
    expect(call.args.p_summary).toBe("Updated company doc.");

    const documents = call.args.p_documents_json as Record<
      string,
      { content: string; sha256: string }
    >;
    expect(documents["company/index.md"].content).toBe("new content");
    expect(call.args.p_content_hash).toBe(canonicalDocumentsHash(documents));
    expect(call.args.p_needs_input_json).toBeNull();
  });

  it("does not fetch a base version and passes null documents/hash on 'no_change'", async () => {
    const { client, calls } = createFakeClient();

    await commitSynthesisResult(
      baseValidated({ outcome: "no_change", documents: {} }),
      client,
    );

    expect(calls.rpcCalls).toHaveLength(1);
    const call = calls.rpcCalls[0];
    expect(call.args.p_outcome).toBe("no_change");
    expect(call.args.p_documents_json).toBeNull();
    expect(call.args.p_content_hash).toBeNull();
  });

  it("passes needs_input through to the RPC untouched", async () => {
    const { client, calls } = createFakeClient();
    const needsInput = [
      {
        question: "Is pricing usage-based or seat-based?",
        current_claim: "usage-based",
        new_claim: "seat-based",
        reason: "conflicting statements across two calls",
        evidence: [{ source_item_id: "item-1", excerpt: "..." }],
      },
    ];

    await commitSynthesisResult(baseValidated({ needs_input: needsInput }), client);

    expect(calls.rpcCalls[0].args.p_needs_input_json).toEqual(needsInput);
  });

  it("resolves without throwing when the RPC reports the base as stale", async () => {
    const { client, calls } = createFakeClient({
      rpcResult: { status: "stale", new_version_id: null },
    });

    await expect(commitSynthesisResult(baseValidated(), client)).resolves.toBeUndefined();
    expect(calls.rpcCalls).toHaveLength(1);
  });

  it("throws when the RPC call itself errors", async () => {
    const { client } = createFakeClient();
    const failingClient = {
      from: (client as unknown as { from: (t: string) => unknown }).from,
      rpc: async () => ({ data: null, error: new Error("boom") }),
    } as unknown as SupabaseClient;

    await expect(commitSynthesisResult(baseValidated(), failingClient)).rejects.toThrow(
      "boom",
    );
  });
});
