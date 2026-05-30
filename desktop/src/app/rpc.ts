// desktop/src/app/rpc.ts — renderer-side RPC singleton
//
// Defines all webview-side handlers (bun → renderer calls) and exposes the
// rpc object for renderer components to make bun-side requests.
//
// Import this module exactly once — from index.tsx. Components import `rpc`
// from this file for request calls.

import { Electroview } from "electrobun/view";
import type { AppRPCType } from "../rpc/schema";

// ── Event bus for webview push messages ────────────────────────────────────────
// Phase 2+: components subscribe to these events to react to bun-initiated
// pushes (new proposal, daemon stopped, badge update). Empty in Phase 1.

type EventMap = {
  proposalAdded: { source: string; count: number };
  daemonStopped: Record<string, never>;
  captureComplete: { source: string };
  badgeUpdate: { count: number };
};

// Internal listener type — erased at call sites; external API remains typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (data: any) => void;
const listeners: Partial<Record<keyof EventMap, AnyFn[]>> = {};

export const events = {
  on<K extends keyof EventMap>(event: K, fn: (data: EventMap[K]) => void): () => void {
    const arr: AnyFn[] = listeners[event] ?? [];
    listeners[event] = arr;
    arr.push(fn as AnyFn);
    return () => {
      listeners[event] = listeners[event]?.filter((l) => l !== (fn as AnyFn));
    };
  },
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]) {
    listeners[event]?.forEach((l) => (l as AnyFn)(data));
  },
};

// ── RPC singleton ──────────────────────────────────────────────────────────────

export const rpc = Electroview.defineRPC<AppRPCType>({
  handlers: {
    requests: {
      // Phase 4: bun asks renderer to confirm a load-team diff
      confirmLoad: async () => false,
    },
    messages: {
      // Phase 2: new proposal arrived from daemon
      proposalAdded: (data) => events.emit("proposalAdded", data),

      // Phase 2: heartbeat went stale — daemon stopped
      daemonStopped: (data) => events.emit("daemonStopped", data),

      // Phase 2: daemon completed a capture cycle
      captureComplete: (data) => events.emit("captureComplete", data),

      // Phase 2: update badge count in nav
      badgeUpdate: (data) => events.emit("badgeUpdate", data),
    },
  },
});
