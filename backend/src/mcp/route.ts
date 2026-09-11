import { createMcpHandler } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { auth } from "../auth/better-auth";
import { loadConfig } from "../config";
import { buildMcpServer } from "./tools";

const config = loadConfig();

// Stateless serving: a fresh McpServer is built per request from the
// verified caller's userId, so tool state never leaks across callers.
const mcpHttpHandler = createMcpHandler((ctx) => {
  const userId = (ctx.authInfo as { userId?: string } | undefined)?.userId;
  if (!userId) throw new Error("buildMcpServer called without a verified caller");
  return buildMcpServer(userId);
});

/** Verifies the bearer token against Better Auth's JWKS and forwards the claims as MCP AuthInfo. */
const protectedHandler = requireMcpAuth(
  auth,
  async (request, claims) => {
    const sub = typeof claims.sub === "string" ? claims.sub : undefined;
    if (!sub) return Response.json({ error: "invalid_token" }, { status: 401 });

    return mcpHttpHandler.fetch(request, {
      authInfo: {
        token: request.headers.get("authorization")?.slice("Bearer ".length) ?? "",
        clientId: typeof claims.client_id === "string" ? claims.client_id : "",
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
        userId: sub,
      } as never,
    });
  },
  { resource: config.mcpResourceUrl, requiredScopes: ["read"] },
);

export const GET = protectedHandler;
export const POST = protectedHandler;
export const DELETE = protectedHandler;
