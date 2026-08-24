import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../../errors/record-error";

function fakeClient(insertError: unknown = null, shouldThrow = false) {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      expect(table).toBe("errors");
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          if (shouldThrow) throw new Error("logger secret=do-not-leak");
          return { error: insertError };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserts };
}

describe("recordError", () => {
  it("maps every schema field and stores a stable code in redacted detail", async () => {
    const { client, inserts } = fakeClient();
    const error = Object.assign(new Error("request failed token=abc with credentials xyz"), { code: "PGRST500", details: "Bearer xyz" });
    await recordError({
      client,
      workspaceId: "ws-1",
      sourceConnectionId: "conn-1",
      scheduledTaskId: "task-1",
      synthesisRunId: "run-1",
      operation: "execution",
      message: "failed https://example.test/cb?token=secret&ok=1 and https://storage.test/file?X-Goog-Credential=user&X-Goog-Signature=signed&X-Goog-Expires=60",
      code: "sandbox_launch_failed",
      detail: {
        stage: "launch",
        credential_id: "cred-1",
        provider: "openai",
        raw_model_output: "model debugging output",
        transcript_id: "tx-1",
        transcript: "private words",
        transcript_text: "transcript debugging text",
        content: "debug content",
        content_markdown: "# Debug content",
        transcript_length: 42,
        token_expires_at: "tomorrow",
        request_id: "req-1",
        response_status: 503,
        authorization: "Bearer hidden",
        nested: { api_key: "hidden", url: "https://x.test?a=1&signature=signed" },
      },
      error,
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      workspace_id: "ws-1",
      source_connection_id: "conn-1",
      scheduled_task_id: "task-1",
      synthesis_run_id: "run-1",
      operation: "execution",
      message: "failed https://example.test/cb?token=[REDACTED]&ok=1 and https://storage.test/file?X-Goog-Credential=[REDACTED]&X-Goog-Signature=[REDACTED]&X-Goog-Expires=[REDACTED]",
      detail_json: {
        code: "sandbox_launch_failed",
        credential_id: "cred-1",
        provider: "openai",
        raw_model_output: "model debugging output",
        transcript_id: "tx-1",
        transcript: "private words",
        transcript_text: "transcript debugging text",
        content: "debug content",
        content_markdown: "# Debug content",
        transcript_length: 42,
        token_expires_at: "tomorrow",
        request_id: "req-1",
        response_status: 503,
        authorization: "[REDACTED]",
        nested: { api_key: "[REDACTED]", url: "https://x.test?a=1&signature=[REDACTED]" },
        error: { name: "Error", message: "request failed token=[REDACTED] with credentials [REDACTED]", code: "PGRST500", details: "Bearer [REDACTED]" },
      },
    });
    expect(String(inserts[0].stack_trace)).not.toContain("token=abc");
    expect(String(inserts[0].stack_trace)).not.toContain("credentials xyz");
  });

  it("keeps only safe diagnostic fields from untrusted error objects", async () => {
    const circular: Record<string, unknown> = {
      name: "PostgrestError", message: "db failed", code: "23505", details: "constraint detail",
      hint: "retry later", status: 409, provider_payload: { private: true }, unknown: "drop me",
    };
    circular.self = circular;
    const { client, inserts } = fakeClient();
    await recordError({ client, workspaceId: "ws", operation: "commit", message: "x", error: circular });
    expect(inserts[0].detail_json).toEqual({ error: {
      name: "PostgrestError", message: "db failed", code: "23505", details: "constraint detail",
      hint: "retry later", status: 409,
    } });

    await recordError({ client, workspaceId: "ws", operation: "read", message: "x", error: "plain failure" });
    expect(inserts[1].detail_json).toEqual({ error: { value: "plain failure" } });

    await recordError({ client, workspaceId: "ws", operation: "read", message: "x", error: 17 });
    expect(inserts[2].detail_json).toEqual({ error: { value: 17 } });
  });

  it("uses exact normalized secret keys while preserving near-name metadata", async () => {
    const { client, inserts } = fakeClient();
    await recordError({
      client, workspaceId: "ws", operation: "read", message: "x",
      detail: {
        access_token: "hidden", "api-key": "hidden", content_markdown: "visible",
        credential_id: "cred-1", transcript_hash: "hash", tokenizer: "safe", secret_status: "safe",
        refresh_token_expires_at: "safe",
        nested: { refreshToken: "hidden", refresh_token: "hidden" },
      },
    });
    expect(inserts[0].detail_json).toEqual({
      access_token: "[REDACTED]", "api-key": "[REDACTED]", content_markdown: "visible",
      credential_id: "cred-1", transcript_hash: "hash", tokenizer: "safe", secret_status: "safe",
      refresh_token_expires_at: "safe",
      nested: { refreshToken: "[REDACTED]", refresh_token: "[REDACTED]" },
    });
  });

  it("handles circular caller detail without rejecting", async () => {
    const { client, inserts } = fakeClient();
    const detail: Record<string, unknown> = { safe: "yes" };
    detail.self = detail;
    await expect(recordError({ client, workspaceId: "ws", operation: "read", message: "x", detail })).resolves.toBeUndefined();
    expect(inserts[0].detail_json).toEqual({ safe: "yes", self: { safe: "yes", self: "[Circular]" } });
  });

  it("does not insert without a workspace and emits a safe structured fallback", async () => {
    const { client, inserts } = fakeClient();
    let stderrOutput = "";
    const stderr = mock((value: unknown) => { stderrOutput = String(value); });
    const original = console.error;
    console.error = stderr;
    try {
      await expect(recordError({
        client,
        workspaceId: null,
        operation: "auth",
        message: "request token=abc failed",
        error: new Error("Bearer hidden-token"),
        code: "auth_failed",
        detail: {
          linear_webhook_id: "webhook-safe-1",
          api_token: "api-token-canary",
          signing_secret: "signing-secret-canary",
          nested: { provider_payload: "provider-raw-canary" },
        },
      })).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(inserts).toHaveLength(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderrOutput).toContain('"code":"auth_failed"');
    expect(stderrOutput).toContain('"message":"request token=[REDACTED] failed"');
    expect(stderrOutput).toContain('"linear_webhook_id":"webhook-safe-1"');
    expect(stderrOutput).toContain('"api_token":"[REDACTED]"');
    expect(stderrOutput).toContain('"signing_secret":"[REDACTED]"');
    expect(stderrOutput).toContain('"provider_payload":"[REDACTED]"');
    expect(stderrOutput).toContain("Bearer [REDACTED]");
    expect(stderrOutput).not.toContain("abc");
    expect(stderrOutput).not.toContain("hidden-token");
    expect(stderrOutput).not.toContain("api-token-canary");
    expect(stderrOutput).not.toContain("signing-secret-canary");
    expect(stderrOutput).not.toContain("provider-raw-canary");
  });

  it("never rejects when the database client throws or returns an error", async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      const throwing = fakeClient(null, true);
      await expect(recordError({ client: throwing.client, workspaceId: "ws", operation: "queue", message: "x" })).resolves.toBeUndefined();
      const returning = fakeClient({ message: "insert failed", authorization: "hidden" });
      await expect(recordError({ client: returning.client, workspaceId: "ws", operation: "queue", message: "x" })).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
  });
});
