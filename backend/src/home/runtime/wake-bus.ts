import type { SupabaseClient } from "@supabase/supabase-js";
import type { WakeBus } from "./ports";

const CHANNEL = "embedded-agent:wake";
const EVENT = "wake";

/**
 * Tells the backend process that owns a Home that it has work. One shared channel carries session ids only: nothing secret and
 * nothing durable, since the input is already saved and the sweep finds it if the wake is lost.
 */
export function createSupabaseWakeBus(client: SupabaseClient): WakeBus {
  const handlers = new Set<(sessionId: string) => void>();
  let channel: ReturnType<SupabaseClient["channel"]> | undefined;
  let ready: Promise<void> | undefined;

  const connect = (): Promise<void> => {
    ready ??= new Promise<void>((resolve) => {
      channel = client.channel(CHANNEL, { config: { broadcast: { self: false } } });
      channel
        .on("broadcast", { event: EVENT }, ({ payload }) => {
          const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
          if (typeof sessionId === "string") for (const handler of handlers) handler(sessionId);
        })
        // A channel that cannot subscribe is not an error: the sweep still delivers.
        .subscribe(() => resolve());
      setTimeout(resolve, 5_000);
    });
    return ready;
  };

  return {
    async notify(sessionId) {
      await connect();
      await channel!.send({ type: "broadcast", event: EVENT, payload: { sessionId } }).catch(() => {});
    },
    listen(handler) {
      handlers.add(handler);
      void connect();
      return () => handlers.delete(handler);
    },
  };
}
