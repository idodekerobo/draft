"use client";

import { useEffect, useRef } from "react";
import type { LiveSessionsApi } from "./types";

export type WatchSignals = NonNullable<LiveSessionsApi["watchSignals"]>;

/** With signals, a poll is only a safety net. Without them, it is how the app learns. */
export const SESSION_SAFETY_POLL_MS = 60_000;
export const LIST_SAFETY_POLL_MS = 300_000;

/**
 * Runs `run` after a signal, once for a burst of signals. A signal that arrives while `run` is going
 * runs it once more afterwards. `run` gets the names of the events since the last run.
 */
export function createRefresher(run: (events: Set<string>) => unknown, delayMs = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;
  let pending = new Set<string>();

  const start = async () => {
    const events = pending;
    pending = new Set();
    running = true;
    try {
      await run(events);
    } catch {
      // The next signal or the safety poll tries again.
    } finally {
      running = false;
      if (pending.size > 0 && !stopped) void start();
    }
  };

  return {
    trigger(event: string) {
      if (stopped) return;
      pending.add(event);
      if (running || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void start();
      }, delayMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Watches one topic while mounted. Does nothing when there is no `watch`. */
/** A busy workspace signals on every event of every session, so its lists wait this long to gather a burst. */
export const WORKSPACE_SIGNAL_DELAY_MS = 1_500;

export function useSignals(watch: WatchSignals | undefined, topic: string | null, onSignal: (events: Set<string>) => unknown, delayMs?: number) {
  const latest = useRef(onSignal);
  latest.current = onSignal;

  useEffect(() => {
    if (!watch || !topic) return;
    const refresher = createRefresher((events) => latest.current(events), delayMs);
    const stop = watch(topic, (event) => refresher.trigger(event));
    return () => {
      stop();
      refresher.stop();
    };
  }, [watch, topic, delayMs]);
}
