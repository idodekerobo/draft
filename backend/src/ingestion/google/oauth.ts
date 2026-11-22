import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { GoogleOAuthSettings } from "../../config";
import { describeGoogleError, googleRequest, readGoogleError, type GoogleRequestOptions } from "./request";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const REQUESTED_SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ID_TOKEN_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  scopes: string[];
  expiresInSeconds: number;
}

export interface GoogleIdentity {
  sub: string;
  email: string | null;
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// offline + consent force Google to return a refresh token on every connect.
export function buildGoogleAuthUrl(
  settings: GoogleOAuthSettings,
  input: { state: string; codeChallenge: string; loginHint?: string | null },
): string {
  const params = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: "code",
    scope: REQUESTED_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${AUTH_URL}?${params.toString()}`;
}

async function postForm(url: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

async function parseTokenResponse(response: Response): Promise<GoogleTokenResponse> {
  if (!response.ok) {
    const info = await readGoogleError(response);
    const code = info.reason ?? "token_request_failed";
    throw new GoogleOAuthError(describeGoogleError("Google token", info), code, response.status);
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    throw new GoogleOAuthError("Google token response had no access_token", "invalid_token_response");
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    idToken: typeof json.id_token === "string" ? json.id_token : null,
    scopes: typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : [],
    expiresInSeconds: typeof json.expires_in === "number" ? json.expires_in : 3600,
  };
}

export async function exchangeGoogleCode(
  settings: GoogleOAuthSettings,
  input: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  const response = await postForm(
    TOKEN_URL,
    {
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: settings.redirectUri,
    },
    fetchImpl,
  );
  return parseTokenResponse(response);
}

// An `invalid_grant` error means the refresh token expired or was revoked.
export async function refreshGoogleAccessToken(
  settings: GoogleOAuthSettings,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  requestOptions: GoogleRequestOptions = {},
): Promise<GoogleTokenResponse> {
  const body = {
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  };
  // Refreshing is safe to repeat, unlike exchanging a one-time authorization code.
  const result = await googleRequest(() => postForm(TOKEN_URL, body, fetchImpl), requestOptions);
  if (!result.ok) {
    const code = result.info.reason ?? "token_request_failed";
    throw new GoogleOAuthError(describeGoogleError("Google token", result.info, result.attempts), code, result.info.status);
  }
  return parseTokenResponse(result.response);
}

export async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await postForm(REVOKE_URL, { token }, fetchImpl);
  // 400 invalid_token means the grant is already gone, which is the goal.
  if (!response.ok && response.status !== 400) {
    throw new GoogleOAuthError("Google token revoke failed", "revoke_failed", response.status);
  }
}

const defaultJwks = createRemoteJWKSet(new URL(JWKS_URL));

export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  keys: Parameters<typeof jwtVerify>[1] = defaultJwks,
): Promise<GoogleIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, keys, { issuer: ID_TOKEN_ISSUERS, audience: clientId });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new GoogleOAuthError("Google id_token has no sub", "invalid_id_token");
    }
    return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
  } catch (error) {
    if (error instanceof GoogleOAuthError) throw error;
    throw new GoogleOAuthError("Google id_token failed verification", "invalid_id_token");
  }
}
