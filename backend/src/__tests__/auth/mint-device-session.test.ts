import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mintDeviceSession } from "../../auth/mint-device-session";

interface Fakes {
  email?: string | null;
  hashedToken?: string | null;
  session?: { access_token: string; refresh_token: string; expires_at: number; expires_in: number } | null;
  verifyError?: { message: string } | null;
}

function deps(fakes: Fakes) {
  const calls: { linkEmail?: string; verify?: { token_hash: string; type: string } } = {};
  const admin = {
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: fakes.email === null ? { email: undefined } : { email: fakes.email ?? "a@b.test" } } }),
        generateLink: async ({ email }: { email: string }) => {
          calls.linkEmail = email;
          return { data: { properties: fakes.hashedToken === null ? {} : { hashed_token: fakes.hashedToken ?? "hash" } } };
        },
      },
    },
  } as unknown as SupabaseClient;
  const anon = {
    auth: {
      verifyOtp: async (params: { token_hash: string; type: string }) => {
        calls.verify = params;
        return { data: { session: fakes.session === undefined ? { access_token: "at", refresh_token: "rt", expires_at: 9, expires_in: 3600 } : fakes.session }, error: fakes.verifyError ?? null };
      },
    },
  } as unknown as SupabaseClient;
  return { admin, anon, calls };
}

describe("mintDeviceSession", () => {
  it("returns a fresh session for the user's email", async () => {
    const d = deps({ email: "ido@example.test", hashedToken: "h1" });
    expect(await mintDeviceSession("u1", d)).toEqual({ access_token: "at", refresh_token: "rt", expires_at: 9, expires_in: 3600 });
    expect(d.calls.linkEmail).toBe("ido@example.test");
    expect(d.calls.verify).toEqual({ token_hash: "h1", type: "magiclink" });
  });
  it("returns null when the user has no email", async () => {
    expect(await mintDeviceSession("u1", deps({ email: null }))).toBeNull();
  });
  it("returns null when no link token is issued", async () => {
    expect(await mintDeviceSession("u1", deps({ hashedToken: null }))).toBeNull();
  });
  it("returns null when the token exchange fails", async () => {
    expect(await mintDeviceSession("u1", deps({ session: null, verifyError: { message: "boom" } }))).toBeNull();
  });
});
