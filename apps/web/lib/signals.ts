import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

type Listener = (event: string) => void;
interface Entry {
  channel: RealtimeChannel;
  listeners: Set<Listener>;
  leave: () => void;
}

/**
 * Listens to private signal topics. Two components that watch the same topic share one channel,
 * because a socket cannot join one topic twice. Every listener gets `catch-up` when the channel
 * joins, rejoins after a drop, the browser comes back online or the tab becomes visible.
 */
export function createSignalWatcher(getClient: () => Pick<SupabaseClient, "channel" | "removeChannel">) {
  const entries = new Map<string, Entry>();

  function join(topic: string): Entry {
    const client = getClient();
    const channel = client.channel(topic, { config: { private: true } });
    const listeners = new Set<Listener>();
    const tell = (event: string) => listeners.forEach((listener) => listener(event));
    const onOnline = () => tell("catch-up");
    const onVisible = () => {
      if (document.visibilityState === "visible") tell("catch-up");
    };
    channel.on("broadcast", { event: "*" }, (message) => tell(message.event)).subscribe((status) => {
      if (status === "SUBSCRIBED") tell("catch-up");
    });
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return {
      channel,
      listeners,
      leave: () => {
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisible);
        void client.removeChannel(channel);
      },
    };
  }

  return function watch(topic: string, onSignal: Listener): () => void {
    const entry = entries.get(topic) ?? join(topic);
    entries.set(topic, entry);
    entry.listeners.add(onSignal);
    return () => {
      entry.listeners.delete(onSignal);
      if (entry.listeners.size > 0) return;
      entries.delete(topic);
      entry.leave();
    };
  };
}
