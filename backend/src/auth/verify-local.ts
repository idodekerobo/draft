import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig } from "../config";

export type LocalVerifier = (token: string) => Promise<string | null>;

export function createLocalVerifier(deps: { issuer: string; getKey: Parameters<typeof jwtVerify>[1] }): LocalVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, deps.getKey, { issuer: deps.issuer, audience: "authenticated", algorithms: ["ES256"] });
      return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  };
}

let defaultVerifier: LocalVerifier | undefined;

/** Checks Supabase access tokens against the project's public keys. Built once, on first use. */
export function getLocalVerifier(): LocalVerifier {
  if (!defaultVerifier) {
    const supabaseUrl = loadConfig().supabaseUrl;
    defaultVerifier = createLocalVerifier({
      issuer: `${supabaseUrl}/auth/v1`,
      getKey: createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`)),
    });
  }
  return defaultVerifier;
}
