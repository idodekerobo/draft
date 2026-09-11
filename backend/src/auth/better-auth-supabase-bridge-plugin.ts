import { createAuthEndpoint } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { verifyBearerHeader } from "./verify";
import { createBridgeTicket, consumeBridgeTicket } from "./bridge-ticket-store";
import { loadConfig } from "../config";

const config = loadConfig();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function provisionBetterAuthUser(ctx: any, userId: string) {
  let user = await ctx.context.internalAdapter.findUserById(userId);
  if (!user) {
    // adapter.create (not internalAdapter.createUser) so the Supabase id
    // can be forced as the primary key instead of Better Auth generating
    // its own.
    user = await ctx.context.adapter.create({
      model: "user",
      data: {
        id: userId,
        email: `${userId}@users.draftai.us`,
        emailVerified: true,
        name: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      forceAllowId: true,
    });
  }
  return user;
}

/**
 * Bridges a Supabase session into a Better Auth one, in two steps so the
 * session cookie is set on a top-level navigation response rather than a
 * background fetch — browsers silently drop Set-Cookie from cross-origin
 * XHR/fetch responses (third-party cookie blocking) regardless of CORS or
 * SameSite config, but always honor it on a real page navigation.
 */
export const supabaseSessionBridge = () => ({
  id: "supabase-session-bridge",
  endpoints: {
    /** POST /auth/bridge-supabase-session/start — verifies the Supabase token, returns a one-time ticket (no cookie set here). */
    startBridgeSupabaseSession: createAuthEndpoint(
      "/bridge-supabase-session/start",
      { method: "POST" },
      async (ctx) => {
        const caller = await verifyBearerHeader(ctx.headers ?? new Headers());
        if (!caller) {
          throw new APIError("UNAUTHORIZED", { message: "invalid_supabase_session" });
        }
        return ctx.json({ ticket: createBridgeTicket(caller.userId) });
      },
    ),

    /** GET /auth/bridge-supabase-session — top-level navigation target: consumes the ticket, sets the session cookie, redirects onward. */
    bridgeSupabaseSession: createAuthEndpoint(
      "/bridge-supabase-session",
      { method: "GET", query: z.object({ ticket: z.string(), redirect: z.string() }) },
      async (ctx) => {
        if (!ctx.query.redirect.startsWith(`${config.apiBaseUrl}/api/auth/oauth2/authorize?`)) {
          throw new APIError("BAD_REQUEST", { message: "invalid_redirect" });
        }
        const userId = consumeBridgeTicket(ctx.query.ticket);
        if (!userId) {
          throw new APIError("UNAUTHORIZED", { message: "invalid_or_expired_ticket" });
        }

        const user = await provisionBetterAuthUser(ctx, userId);
        if (!user) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "failed_to_provision_better_auth_user" });
        }

        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect(ctx.query.redirect);
      },
    ),
  },
});
