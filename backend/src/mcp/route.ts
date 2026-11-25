import { createMcpHandler } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { auth } from "../auth/better-auth";
import { loadConfig } from "../config";
import { buildMcpServer } from "./tools";
import { verifyRequest } from "../auth/verify";
import { authorizeOwned } from "../routes/sessions-live-shared";
import { serviceClient } from "../db/client";
import { createDraftToolRegistry } from "../metaharness/tools/definitions";
import { userInvokeDeps } from "../metaharness/tools/user-gateway";
import { createSessionMcpHandler, hasSessionContext, sessionTargetDenial } from "./session-auth";
import { createLoggedMcpHandler } from "./request-logging";

const config = loadConfig();

// Stateless serving: a fresh McpServer is built per request from the
// verified caller's userId, so tool state never leaks across callers.
const mcpHttpHandler = createMcpHandler((ctx) => {
  const authInfo = ctx.authInfo as { userId?: string; scopes?: string[] } | undefined;
  const userId = authInfo?.userId;
  const scopes = authInfo?.scopes ?? [];
  if (!userId) throw new Error("buildMcpServer called without a verified caller");
  return buildMcpServer(userId, scopes);
});

/** Verifies the bearer token against Better Auth's JWKS and forwards the claims as MCP AuthInfo. */
const loggedHandler = createLoggedMcpHandler(async (request, context) => requireMcpAuth(
  auth,
  async (request, claims) => {
    const sub = typeof claims.sub === "string" ? claims.sub : undefined;
    if (!sub) {
      context.stage = "missing_subject";
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    context.stage = "mcp_handling";
    context.userId = sub;
    context.clientId = typeof claims.client_id === "string" ? claims.client_id : undefined;
    context.scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];

    return mcpHttpHandler.fetch(request, {
      authInfo: {
        token: request.headers.get("authorization")?.slice("Bearer ".length) ?? "",
        clientId: typeof claims.client_id === "string" ? claims.client_id : "",
        scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
        userId: sub,
      } as never,
    });
  },
  { resource: config.mcpResourceUrl, requiredScopes: ["read", "write"] },
)(request), {
  issuer: `${config.apiBaseUrl}/api/auth`,
  resource: config.mcpResourceUrl,
  requiredScopes: ["read", "write"],
});

const sessionHandler = createSessionMcpHandler({
  verify: verifyRequest,
  async authorize(context, userId) {
    const owned = await authorizeOwned(context.workspaceId, context.sessionId, userId);
    if (!owned.ok) return owned.response;
    return sessionTargetDenial(owned.session, context.hostId);
  },
  async handle(request, context, userId) {
    const handler = createMcpHandler(() => buildMcpServer(userId, ["read", "write"], {
      resolveWorkspaceId: async () => context.workspaceId,
      deps: userInvokeDeps(serviceClient, createDraftToolRegistry(serviceClient), context.sessionId),
    }));
    return handler.fetch(request);
  },
});
const dispatch = (request: Request) => hasSessionContext(request) ? sessionHandler(request) : loggedHandler(request);
export const GET = dispatch;
export const POST = dispatch;
export const DELETE = dispatch;
