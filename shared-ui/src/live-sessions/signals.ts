"use client";

import { useEffect, useRef } from "react";
import { SIGNAL_EVENTS, workspaceSignalTopic } from "draft-core/live-sessions";
import { queryKeys } from "../query/keys";
import { useQueryClient } from "../query";
import type { LiveSessionsApi } from "./types";

export type WatchSignals = NonNullable<LiveSessionsApi["watchSignals"]>;

/** A fast-streaming session signals many times a second; fetches start at most this often. */
export const SESSION_SIGNAL_DELAY_MS = 250;

/** Polls are only safety nets, in case a signal is missed. */
export const SESSION_SAFETY_POLL_MS = 60_000;

/**
 * Runs `run` at once for the first signal. Signals that arrive while it runs, or within `delayMs` of its start,
 * wait for one follow-up run with the names gathered meanwhile. `run` gets those names.
 */
export function createRefresher(run: (events: Set<string>) => unknown, delayMs = SESSION_SIGNAL_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;
  let lastStart = -Infinity;
  let pending = new Set<string>();

  const start = async () => {
    const events = pending;
    pending = new Set();
    running = true;
    lastStart = Date.now();
    try {
      await run(events);
    } catch {
      // The next signal or the safety poll tries again.
    } finally {
      running = false;
      if (pending.size > 0) schedule();
    }
  };

  const schedule = () => {
    if (timer || running || stopped) return;
    const wait = lastStart + delayMs - Date.now();
    if (wait <= 0) {
      void start();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void start();
    }, wait);
  };

  return {
    trigger(event: string) {
      if (stopped) return;
      pending.add(event);
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** A busy workspace signals on every event of every session, so its lists wait this long to gather a burst. */
export const WORKSPACE_SIGNAL_DELAY_MS = 1_500;

/** Watches one topic while mounted. Does nothing when there is no `watch`. */
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

/**
 * Keeps the workspace data fresh from the workspace topic. A context change reloads the context, connections,
 * connected apps and runs. After a dropped connection, only data that has gone stale reloads.
 */
export function useWorkspaceDataSignals(watch: WatchSignals | undefined, workspaceId: string | null) {
  const queryClient = useQueryClient();
  useSignals(
    watch,
    workspaceId ? workspaceSignalTopic(workspaceId) : null,
    async (events) => {
      if (!workspaceId) return;
      const keys = [queryKeys.context(workspaceId), queryKeys.connections(workspaceId), queryKeys.connectedApps(workspaceId), queryKeys.runs(workspaceId)];
      if (events.has(SIGNAL_EVENTS.context)) await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      else if (events.has(SIGNAL_EVENTS.catchUp)) await Promise.all(keys.map((queryKey) => queryClient.refetchQueries({ queryKey, stale: true })));
    },
    WORKSPACE_SIGNAL_DELAY_MS,
  );
}
