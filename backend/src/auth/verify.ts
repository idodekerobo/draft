import { publishableClient } from "../db/client";
import { createAccessTokenVerifier } from "./access-token-verifier";
import { recordRejectedToken } from "./record-rejected-token";
import { getLocalVerifier } from "./verify-local";

export interface VerifiedCaller {
  userId: string;
  accessToken: string;
}

export const verifyAccessToken = createAccessTokenVerifier({
  verifyLocal: (token) => getLocalVerifier()(token),
  verifyRemote: async (token) => {
    const { data, error } = await publishableClient.auth.getUser(token);
    if (error || !data.user) {
      recordRejectedToken(token, error);
      return null;
    }
    return data.user.id;
  },
});

export async function verifyRequest(
  req: Request,
): Promise<VerifiedCaller | null> {
  return verifyBearerHeader(req.headers);
}

export async function verifyBearerHeader(
  headers: Headers,
): Promise<VerifiedCaller | null> {
  const header = headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  return verifyAccessToken(header.slice("Bearer ".length).trim());
}
