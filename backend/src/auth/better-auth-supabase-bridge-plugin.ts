import { createAuthEndpoint } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import { setSessionCookie } from "better-auth/cookies";
import { verifyBearerHeader } from "./verify";

/**
 * POST /auth/bridge-supabase-session — trades a Supabase access token for a
 * Better Auth session, lazy-provisioning the matching `better_auth.user`
 * row (id-matched to the Supabase user) on first call.
 */
export const supabaseSessionBridge = () => ({
  id: "supabase-session-bridge",
  endpoints: {
    bridgeSupabaseSession: createAuthEndpoint(
      "/bridge-supabase-session",
      { method: "POST" },
      async (ctx) => {
        const caller = await verifyBearerHeader(ctx.headers ?? new Headers());
        if (!caller) {
          throw new APIError("UNAUTHORIZED", { message: "invalid_supabase_session" });
        }

        let user = await ctx.context.internalAdapter.findUserById(caller.userId);
        if (!user) {
          // Use adapter.create (not internalAdapter.createUser) so the
          // Supabase id can be forced as the primary key instead of
          // Better Auth generating its own.
          user = await ctx.context.adapter.create({
            model: "user",
            data: {
              id: caller.userId,
              email: `${caller.userId}@users.draftai.us`,
              emailVerified: true,
              name: caller.userId,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            forceAllowId: true,
          });
        }
        if (!user) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "failed_to_provision_better_auth_user" });
        }

        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ ok: true });
      },
    ),
  },
});
