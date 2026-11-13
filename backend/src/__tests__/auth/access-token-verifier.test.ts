import { describe, expect, it } from "bun:test";
import { createAccessTokenVerifier } from "../../auth/access-token-verifier";

function setup(local: string | null, remote: string | null) {
  const calls = { local: 0, remote: 0 };
  const verify = createAccessTokenVerifier({
    verifyLocal: async () => (calls.local++, local),
    verifyRemote: async () => (calls.remote++, remote),
  });
  return { verify, calls };
}

describe("createAccessTokenVerifier", () => {
  it("accepts a token the local check knows, without asking Supabase", async () => {
    const { verify, calls } = setup("user-1", null);
    expect(await verify("tok")).toEqual({ userId: "user-1", accessToken: "tok" });
    expect(calls).toEqual({ local: 1, remote: 0 });
  });

  it("asks Supabase once when the local check rejects the token", async () => {
    const { verify, calls } = setup(null, "user-2");
    expect(await verify("tok")).toEqual({ userId: "user-2", accessToken: "tok" });
    expect(calls).toEqual({ local: 1, remote: 1 });
  });

  it("returns null when both checks reject the token", async () => {
    const { verify, calls } = setup(null, null);
    expect(await verify("tok")).toBeNull();
    expect(calls).toEqual({ local: 1, remote: 1 });
  });

  it("returns null for an empty token without calling either check", async () => {
    const { verify, calls } = setup("user-1", "user-1");
    expect(await verify("")).toBeNull();
    expect(calls).toEqual({ local: 0, remote: 0 });
  });
});
