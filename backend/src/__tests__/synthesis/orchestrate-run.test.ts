import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { completeSynthesisRunCallback } from "../../synthesis/orchestrate-run";
import { createSandboxCallbackToken } from "../../sandbox/callback-token";

const secret = "super-sensitive-callback-secret";
const runId = "55555555-5555-4555-8555-555555555555";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const baseVersionId = "44444444-4444-4444-8444-444444444444";
const bundleHash = "a".repeat(64);
// completeSynthesisRunCallback has no `now` override -- it verifies against
// real wall-clock time -- so expiresAt must be a real future timestamp.
const claims = { runId, bundleHash, expiresAt: Date.now() + 60_000, nonce: "nonce-1" };

interface FakeClientOptions {
  transcriptUpdateResult?: { error: Error | null };
  transcriptUpdateThrows?: boolean;
  rpcResult?: { status: "committed" | "stale"; new_version_id: string | null };
}

/**
 * Fake Supabase client covering exactly the query shapes
 * completeSynthesisRunCallback's path exercises: the header-based workspace
 * lookup (kept empty so recordError takes its no-DB fallback branch and this
 * fake doesn't need an "errors" table), the new transcript_json update, and
 * the real validateSynthesisResult/commitSynthesisResult reads/RPC.
 */
function createFakeClient(options: FakeClientOptions = {}) {
  const calls: {
    transcriptUpdates: Array<{ payload: Record<string, unknown>; id: string }>;
    rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  } = { transcriptUpdates: [], rpcCalls: [] };

  const runRow = { id: runId, workspace_id: workspaceId, base_context_version_id: baseVersionId };
  const baseDocuments = { "company/index.md": { content: "base content", sha256: "b".repeat(64) } };

  function from(table: string) {
    if (table === "synthesis_runs") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: runRow, error: null }),
            // Header-based workspace lookup: always "not found" so recordError
            // takes its no-DB console fallback path in every test here.
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, id: string) => {
            calls.transcriptUpdates.push({ payload, id });
            if (options.transcriptUpdateThrows) throw new Error("connection reset");
            return options.transcriptUpdateResult ?? { error: null };
          },
        }),
      };
    }
    if (table === "workspace_context_versions") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { documents_json: baseDocuments }, error: null }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    calls.rpcCalls.push({ fn, args });
    return { data: options.rpcResult ?? { status: "committed", new_version_id: "66666666-6666-4666-8666-666666666666" }, error: null };
  }

  const client = { from, rpc } as unknown as SupabaseClient;
  return { client, calls };
}

function callbackRequest(body: unknown): Request {
  const token = createSandboxCallbackToken(claims, secret);
  return new Request("http://internal.test/callback", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": `draft:${runId}:${bundleHash}`,
      "x-draft-run-id": runId,
      "x-draft-bundle-hash": bundleHash,
    },
    body: JSON.stringify(body),
  });
}

describe("completeSynthesisRunCallback transcript persistence", () => {
  it("writes transcript_json on a successful callback", async () => {
    const { client, calls } = createFakeClient();
    const transcript = [{ type: "system" }, { type: "result", is_error: false }];

    const response = await completeSynthesisRunCallback(
      callbackRequest({
        run_id: runId,
        bundle_hash: bundleHash,
        result: { outcome: "no_change", summary: "nothing changed" },
        transcript,
      }),
      secret,
      client,
    );

    expect(response.status).toBe(204);
    expect(calls.transcriptUpdates).toEqual([{ payload: { transcript_json: transcript }, id: runId }]);
    expect(calls.rpcCalls).toHaveLength(1);
  });

  it("writes transcript_json even when validation fails (runner-reported claude_error)", async () => {
    const { client, calls } = createFakeClient();
    const transcript = [{ type: "system" }, { type: "result", is_error: true }];

    await expect(
      completeSynthesisRunCallback(
        callbackRequest({
          run_id: runId,
          bundle_hash: bundleHash,
          result: { error: "claude_error", diagnostics: { failureCode: "claude_error" } },
          transcript,
        }),
        secret,
        client,
      ),
    ).rejects.toThrow("invalid outcome: undefined");

    expect(calls.transcriptUpdates).toEqual([{ payload: { transcript_json: transcript }, id: runId }]);
    expect(calls.rpcCalls).toHaveLength(0);
  });

  it("does not block the callback when the transcript write itself fails", async () => {
    const { client, calls } = createFakeClient({
      transcriptUpdateResult: { error: new Error("update rejected") },
    });

    const response = await completeSynthesisRunCallback(
      callbackRequest({
        run_id: runId,
        bundle_hash: bundleHash,
        result: { outcome: "no_change", summary: "nothing changed" },
        transcript: [{ type: "system" }],
      }),
      secret,
      client,
    );

    expect(response.status).toBe(204);
    expect(calls.rpcCalls).toHaveLength(1);
  });

  it("does not block the callback when the transcript write throws", async () => {
    const { client, calls } = createFakeClient({ transcriptUpdateThrows: true });

    const response = await completeSynthesisRunCallback(
      callbackRequest({
        run_id: runId,
        bundle_hash: bundleHash,
        result: { outcome: "no_change", summary: "nothing changed" },
        transcript: [{ type: "system" }],
      }),
      secret,
      client,
    );

    expect(response.status).toBe(204);
    expect(calls.rpcCalls).toHaveLength(1);
  });

  it("skips the transcript write entirely when the callback carries no transcript", async () => {
    const { client, calls } = createFakeClient();

    const response = await completeSynthesisRunCallback(
      callbackRequest({
        run_id: runId,
        bundle_hash: bundleHash,
        result: { outcome: "no_change", summary: "nothing changed" },
      }),
      secret,
      client,
    );

    expect(response.status).toBe(204);
    expect(calls.transcriptUpdates).toHaveLength(0);
  });
});
