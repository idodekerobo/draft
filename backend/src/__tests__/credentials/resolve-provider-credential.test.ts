import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredentialPayload } from "../../credentials/crypto";
import { CredentialError, resolveProviderCredential } from "../../credentials/resolve-provider-credential";

const ids = {
  workspace: "55555555-5555-4555-8555-555555555555",
  connection: "66666666-6666-4666-8666-666666666666",
  credential: "77777777-7777-4777-8777-777777777777",
};

const KEY_VERSION = "v1";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V1 = randomBytes(32).toString("base64");
});

interface FakeClientOptions {
  connection?: { id: string; credential_id: string | null; status: string } | null;
  credential?: {
    id: string;
    status: string;
    expires_at: string | null;
    encrypted_payload: unknown;
    encryption_key_version: string;
  } | null;
  failOnCredentialLookup?: boolean;
}

function createFakeClient(options: FakeClientOptions) {
  function from(table: string) {
    if (table === "source_connections") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  options.connection === undefined
                    ? { id: ids.connection, credential_id: ids.credential, status: "active" }
                    : options.connection,
                error: null,
              }),
            }),
          }),
        }),
      };
    }

    if (table === "credentials") {
      if (options.failOnCredentialLookup) throw new Error("credential lookup must not run");
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

function activeCredential(
  payload: unknown,
  overrides: Partial<{ expires_at: string | null; status: string }> = {},
) {
  return {
    id: ids.credential,
    status: "active",
    expires_at: null,
    encrypted_payload: payload,
    encryption_key_version: KEY_VERSION,
    ...overrides,
  };
}

describe("resolveProviderCredential", () => {
  it("returns a parsed named-secret object for fireflies", async () => {
    const secrets = { api_token: "ff-token", webhook_secret: "ff-webhook-secret" };
    const client = createFakeClient({
      credential: activeCredential(
        encryptCredentialPayload(JSON.stringify(secrets), KEY_VERSION),
      ),
    });

    const resolved = await resolveProviderCredential(ids.workspace, "fireflies", client);
    expect(resolved).toEqual(secrets);
  });

  it("returns a parsed named-secret object for slack", async () => {
    const secrets = { bot_token: "xoxb-...", app_token: "xapp-..." };
    const client = createFakeClient({
      credential: activeCredential(
        encryptCredentialPayload(JSON.stringify(secrets), KEY_VERSION),
      ),
    });

    const resolved = await resolveProviderCredential(ids.workspace, "slack", client);
    expect(resolved).toEqual(secrets);
  });

  it("returns a raw string for single-secret providers", async () => {
    const client = createFakeClient({
      credential: activeCredential(encryptCredentialPayload("plain-token", KEY_VERSION)),
    });

    const resolved = await resolveProviderCredential(ids.workspace, "granola", client);
    expect(resolved).toBe("plain-token");
  });

  it("throws a typed 'missing' error when no connection exists for the provider", async () => {
    const client = createFakeClient({ connection: null });

    try {
      await resolveProviderCredential(ids.workspace, "fireflies", client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as CredentialError).reason).toBe("missing");
    }
  });

  it("throws a typed 'missing' error when the connection has no credential_id", async () => {
    const client = createFakeClient({
      connection: { id: ids.connection, credential_id: null, status: "active" },
    });

    try {
      await resolveProviderCredential(ids.workspace, "fireflies", client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as CredentialError).reason).toBe("missing");
    }
  });

  it("allows a degraded connection to resolve its credential", async () => {
    const secrets = { api_token: "ff-token", webhook_secret: "ff-secret" };
    const client = createFakeClient({
      connection: { id: ids.connection, credential_id: ids.credential, status: "degraded" },
      credential: activeCredential(
        encryptCredentialPayload(JSON.stringify(secrets), KEY_VERSION),
      ),
    });

    await expect(resolveProviderCredential(ids.workspace, "fireflies", client)).resolves.toEqual(secrets);
  });

  it.each(["pending", "error", "revoked"])(
    "rejects an inactive %s connection before reading or decrypting its credential",
    async (status) => {
      const client = createFakeClient({
        connection: { id: ids.connection, credential_id: ids.credential, status },
        failOnCredentialLookup: true,
      });

      try {
        await resolveProviderCredential(ids.workspace, "fireflies", client);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect((error as CredentialError).reason).toBe("missing");
      }
    },
  );

  it("throws a typed 'revoked' error for a revoked credential", async () => {
    const client = createFakeClient({
      credential: activeCredential(encryptCredentialPayload("{}", KEY_VERSION), {
        status: "revoked",
      }),
    });

    try {
      await resolveProviderCredential(ids.workspace, "slack", client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as CredentialError).reason).toBe("revoked");
    }
  });

  it("throws a typed 'decrypt_failed' error when a named-secret payload isn't valid JSON", async () => {
    const client = createFakeClient({
      credential: activeCredential(encryptCredentialPayload("not-json", KEY_VERSION)),
    });

    try {
      await resolveProviderCredential(ids.workspace, "fireflies", client);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as CredentialError).reason).toBe("decrypt_failed");
    }
  });
});
