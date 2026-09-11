import { publishableClient } from "../db/client";

export interface VerifiedCaller {
  userId: string;
  accessToken: string;
}

export async function verifyAccessToken(
  accessToken: string,
): Promise<VerifiedCaller | null> {
  if (!accessToken) return null;

  const { data, error } = await publishableClient.auth.getUser(accessToken);
  if (error || !data.user) return null;

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
