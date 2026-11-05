import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { SIGNAL_EVENTS } from "draft-core/live-sessions";

type Listener = (event: string) => void;
interface Entry {
  channel: RealtimeChannel;
  listeners: Set<Listener>;
  subscribed: boolean;
  leave: () => void;
}

/**
 * Listens to private signal topics. Two components that watch the same topic share one channel,
 * because a socket cannot join one topic twice. Every listener gets `catch-up` when the channel
 * joins, rejoins after a drop, the browser comes back online or the tab becomes visible.
 */
export function createSignalWatcher(getClient: () => Pick<SupabaseClient, "channel" | "removeChannel">) {
  const entries = new Map<string, Entry>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  const connected = () => [...entries.values()].every((entry) => entry.subscribed);
  const reportConnection = () => connectionListeners.forEach((listener) => listener(connected()));

  function join(topic: string): Entry {
    const client = getClient();
    const channel = client.channel(topic, { config: { private: true } });
    const listeners = new Set<Listener>();
    const tell = (event: string) => listeners.forEach((listener) => listener(event));
    const onOnline = () => tell(SIGNAL_EVENTS.catchUp);
    const onVisible = () => {
      if (document.visibilityState === "visible") tell(SIGNAL_EVENTS.catchUp);
    };
    const entry: Entry = { channel, listeners, subscribed: false, leave: () => {} };
    channel.on("broadcast", { event: "*" }, (message) => tell(message.event)).subscribe((status) => {
      entry.subscribed = status === "SUBSCRIBED";
      reportConnection();
      if (entry.subscribed) tell(SIGNAL_EVENTS.catchUp);
    });
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    entry.leave = () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      void client.removeChannel(channel);
    };
    return entry;
  }

  function watch(topic: string, onSignal: Listener): () => void {
    const existing = entries.get(topic);
    const entry = existing ?? join(topic);
    entries.set(topic, entry);
    entry.listeners.add(onSignal);
    if (!existing) reportConnection();
    return () => {
      entry.listeners.delete(onSignal);
      if (entry.listeners.size > 0) return;
      entries.delete(topic);
      entry.leave();
      reportConnection();
    };
  }

  function watchConnection(onChange: (connected: boolean) => void): () => void {
    connectionListeners.add(onChange);
    onChange(connected());
    return () => void connectionListeners.delete(onChange);
  }

  return { watch, watchConnection };
}
