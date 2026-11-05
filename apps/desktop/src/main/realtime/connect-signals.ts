import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getFreshAccessToken } from "draft-core/auth-state";
import type { SignalSource } from "./realtime-manager";

const TOKEN_REFRESH_MS = 10 * 60_000;
const TICK_MS = 15_000;
// A gap this long between ticks means the computer slept, so the socket and token may be dead.
const SLEEP_GAP_MS = 45_000;

type Client = Pick<SupabaseClient, "channel" | "removeChannel" | "realtime">;

interface Deps {
  makeClient: () => Client;
  getToken: () => Promise<string>;
  now?: () => number;
}

interface Joined {
  onEvent: (event: string) => void;
}

/**
 * One Supabase client for every signal topic of the app. It refreshes the token on a timer and after a
 * sleep, and tells every topic `catch-up` after a sleep. `tick` is exposed so a test can drive time.
 */
export function createSignalSource({ makeClient, getToken, now = Date.now }: Deps) {
  let client: Client | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastTick = now();
  let lastRefresh = 0;
  const joined = new Set<Joined>();

  const refreshToken = async () => {
    client ??= makeClient();
    try {
      await client.realtime.setAuth(await getToken());
      lastRefresh = now();
    } catch (error) {
      console.error("[signals] could not refresh the token", error);
    }
  };

  const tick = async () => {
    const at = now();
    const slept = at - lastTick > SLEEP_GAP_MS;
    lastTick = at;
    if (!slept && at - lastRefresh < TOKEN_REFRESH_MS) return;
    await refreshToken();
    if (slept) joined.forEach((entry) => entry.onEvent("catch-up"));
  };

  const source: SignalSource = (topic, onEvent, onConnected) => {
    const entry: Joined = { onEvent };
    joined.add(entry);
    let stopped = false;
    let leave = () => {};
    void (async () => {
      if (!client || now() - lastRefresh >= TOKEN_REFRESH_MS) await refreshToken();
      if (stopped || !client) return;
      const live = client;
      const channel = live.channel(topic, { config: { private: true } });
      channel.on("broadcast", { event: "*" }, (message) => onEvent(message.event)).subscribe((status) => {
        onConnected(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") onEvent("catch-up");
      });
      leave = () => void live.removeChannel(channel);
      if (stopped) leave();
    })();
    ticker ??= setInterval(() => void tick(), TICK_MS);

    return () => {
      stopped = true;
      joined.delete(entry);
      leave();
      if (joined.size > 0) return;
      if (ticker) clearInterval(ticker);
      ticker = null;
      if (client) void client.realtime.disconnect();
      client = null;
      lastRefresh = 0;
    };
  };

  return { source, tick };
}

const supabaseUrl = () => process.env.DRAFT_SUPABASE_URL ?? "";
const publishableKey = () => process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "";

export const connectSignals: SignalSource = createSignalSource({
  makeClient: () => createClient(supabaseUrl(), publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } }),
  getToken: () => getFreshAccessToken({ supabaseUrl: supabaseUrl(), publishableKey: publishableKey() }),
}).source;
