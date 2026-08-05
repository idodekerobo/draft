import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  InferenceCredentialError,
  encryptCredentialPayload,
  resolveInferenceCredential,
} from "../../synthesis/resolve-credential";

const ids = {
  workspace: "33333333-3333-4333-8333-333333333333",
  credential: "44444444-4444-4444-8444-444444444444",
};

const KEY_VERSION = "v1";

beforeAll(() => {
  // 32 random bytes, base64-encoded, matching the KEK format resolve-credential.ts expects.
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

interface FakeClientOptions {
  inferenceCredentialId?: string | null;
  credential?: {
    id: string;
    workspace_id: string;
    status: string;
    expires_at: string | null;
    encrypted_payload: unknown;
    encryption_key_version: string;
  } | null;
}

/**
 * Minimal fake standing in for the chainable Supabase query builder shape
 * `.from().select().eq().single()` (workspaces) and
 * `.from().select().eq().eq().maybeSingle()` (credentials) used by
 * resolve-credential.ts.
 */
function createFakeClient(options: FakeClientOptions) {
  function from(table: string) {
    if (table === "workspaces") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                inference_credential_id:
                  options.inferenceCredentialId === undefined
                    ? ids.credential
                    : options.inferenceCredentialId,
              },
              error: null,
            }),
          }),
        }),
      };
    }

    if (table === "credentials") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: options.credential ?? null,
                error: null,
              }),
            }),
          }),
        }),
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  return { from } as unknown as SupabaseClient;
}

function activeCredential(overrides: Partial<{
  encrypted_payload: unknown;
  expires_at: string | null;
  status: string;
}> = {}) {
  return {
    id: ids.credential,
    workspace_id: ids.workspace,
    status: "active",
    expires_at: null,
    encrypted_payload: encryptCredentialPayload("sk-ant-oat-test-token", KEY_VERSION),
    encryption_key_version: KEY_VERSION,
    ...overrides,
  };
}

describe("encryptCredentialPayload / resolveInferenceCredential round trip", () => {
  it("round-trips a plaintext token through encrypt then decrypt", async () => {
    const plaintext = "sk-ant-oat-round-trip-secret";
    const client = createFakeClient({
      credential: activeCredential({
        encrypted_payload: encryptCredentialPayload(plaintext, KEY_VERSION),
      }),
    });

    const resolved = await resolveInferenceCredential(ids.workspace, client);
    expect(resolved).toBe(plaintext);
  });

  it("produces a \\x-prefixed hex bytea string", () => {
    const payload = encryptCredentialPayload("token", KEY_VERSION);
    expect(payload).toMatch(/^\\x[0-9a-f]+$/);
  });
});

describe("resolveInferenceCredential error paths", () => {
  it("throws a typed 'missing' error when workspace has no inference_credential_id", async () => {
    const client = createFakeClient({ inferenceCredentialId: null });

    await expect(resolveInferenceCredential(ids.workspace, client)).rejects.toThrow(
      InferenceCredentialError,
    );
    try {
      await resolveInferenceCredential(ids.workspace, client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceCredentialError);
      expect((error as InferenceCredentialError).reason).toBe("missing");
    }
  });

  it("throws a typed 'missing' error when the credential row does not exist", async () => {
    const client = createFakeClient({ credential: null });

    try {
      await resolveInferenceCredential(ids.workspace, client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceCredentialError);
      expect((error as InferenceCredentialError).reason).toBe("missing");
    }
  });

  it("throws a typed 'revoked' error for a revoked credential", async () => {
    const client = createFakeClient({
      credential: activeCredential({ status: "revoked" }),
    });

    try {
      await resolveInferenceCredential(ids.workspace, client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceCredentialError);
      expect((error as InferenceCredentialError).reason).toBe("revoked");
    }
  });

  it("throws a typed 'expired' error when status is expired", async () => {
    const client = createFakeClient({
      credential: activeCredential({ status: "expired" }),
    });

    try {
      await resolveInferenceCredential(ids.workspace, client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceCredentialError);
      expect((error as InferenceCredentialError).reason).toBe("expired");
    }
  });

  it("throws a typed 'expired' error when expires_at is in the past, even if status says active", async () => {
    const client = createFakeClient({
      credential: activeCredential({
        status: "active",
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    });

    try {
      await resolveInferenceCredential(ids.workspace, client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceCredentialError);
      expect((error as InferenceCredentialError).reason).toBe("expired");
    }
  });

  it("does not throw expired for a future expires_at on an active credential", async () => {
    const client = createFakeClient({
      credential: activeCredential({
        status: "active",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    });

    await expect(resolveInferenceCredential(ids.workspace, client)).resolves.toBe(
      "sk-ant-oat-test-token",
    );
  });

  it("throws a typed 'decrypt_failed' error when the ciphertext has been tampered with", async () => {
    const payload = encryptCredentialPayload("sk-ant-oat-test-token", KEY_VERSION);
    // Flip a hex nibble somewhere in the ciphertext region (after \x + 24 hex
    // chars for iv (12 bytes) + 32 hex chars for authTag (16 bytes) = 56 chars).
    const tamperIndex = 2 + 56 + 2;
    const originalChar = payload[tamperIndex];
    const replacement = originalChar === "0" ? "1" : "0";
    const tampered =
      payload.slice(0, tamperIndex) + replacement + payload.slice(tamperIndex + 1);

    const client = createFakeClient({
      credential: activeCredential({ encrypted_payload: tampered }),
    });

    try {
      await resolveInferenceCredential(ids.workspace, client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceCredentialError);
      expect((error as InferenceCredentialError).reason).toBe("decrypt_failed");
    }
  });

  it("handles encrypted_payload arriving as a raw Buffer/Uint8Array", async () => {
    const hexPayload = encryptCredentialPayload("sk-ant-oat-buffer-token", KEY_VERSION);
    const rawBuffer = Buffer.from(hexPayload.slice(2), "hex");

    const client = createFakeClient({
      credential: activeCredential({ encrypted_payload: rawBuffer }),
    });

    await expect(resolveInferenceCredential(ids.workspace, client)).resolves.toBe(
      "sk-ant-oat-buffer-token",
    );
  });
});
