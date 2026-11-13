import { publishableClient } from "../db/client";
import { recordRejectedToken } from "./record-rejected-token";
import { getLocalVerifier } from "./verify-local";

export interface VerifiedCaller {
  userId: string;
  accessToken: string;
}

export async function verifyAccessToken(
  accessToken: string,
): Promise<VerifiedCaller | null> {
  if (!accessToken) return null;

  if (process.env.LOCAL_JWT_VERIFY === "on") {
    const userId = await getLocalVerifier()(accessToken);
    if (userId) return { userId, accessToken };
  }

  const { data, error } = await publishableClient.auth.getUser(accessToken);
  if (error || !data.user) {
    recordRejectedToken(accessToken, error);
    return null;
  }

  return { userId: data.user.id, accessToken };
}

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
