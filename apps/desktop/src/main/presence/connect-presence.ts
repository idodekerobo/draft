import { createClient } from "@supabase/supabase-js";
import { getFreshAccessToken } from "draft-core/auth-state";
import { presenceChannel, presenceNames, type PresenceMeta } from "draft-core/live-sessions";
import type { ConnectPresence } from "./presence-hub";

const TOKEN_REFRESH_MS = 10 * 60_000;

/** Joins the session's private presence channel as the signed-in user. */
export const connectPresence: ConnectPresence = (sessionId, viewer, onNames) => {
  const supabaseUrl = process.env.DRAFT_SUPABASE_URL ?? "";
  const publishableKey = process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "";
  const client = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const channel = client.channel(presenceChannel(sessionId), { config: { private: true, presence: { key: viewer.id } } });
  let stopped = false;

  const refreshToken = async () => {
    try {
      await client.realtime.setAuth(await getFreshAccessToken({ supabaseUrl, publishableKey }));
    } catch (error) {
      console.error("[presence] could not refresh the token", error);
    }
  };

  channel.on("presence", { event: "sync" }, () => onNames(presenceNames(channel.presenceState<PresenceMeta>(), viewer.id)));
  void refreshToken().then(() => {
    if (stopped) return;
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") void channel.track({ name: viewer.name });
    });
  });
  const timer = setInterval(() => void refreshToken(), TOKEN_REFRESH_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    void client.removeChannel(channel);
    void client.realtime.disconnect();
  };
};
