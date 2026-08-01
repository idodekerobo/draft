import { publishableClient } from "../db/client";

export interface VerifiedCaller {
  userId: string;
  accessToken: string;
}

export async function verifyRequest(
  req: Request,
): Promise<VerifiedCaller | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;

  const accessToken = header.slice("Bearer ".length).trim();
  if (!accessToken) return null;

  const { data, error } = await publishableClient.auth.getUser(accessToken);
  if (error || !data.user) return null;

  return { userId: data.user.id, accessToken };
}
