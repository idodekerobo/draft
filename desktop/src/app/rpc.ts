// desktop/src/app/rpc.ts — renderer-side RPC singleton
//
// Defines all webview-side handlers (bun → renderer calls) and exposes the
// rpc object for renderer components to make bun-side requests.
//
// Import this module exactly once — from index.tsx. Components import `rpc`
// from this file for request calls.

import { Electroview } from "electrobun/view";
import type { AppRPCType, HeadlessSetupPhase } from "../rpc/schema";

// ── Event bus for webview push messages ────────────────────────────────────────
// Components subscribe to these events to react to bun-initiated pushes.

type EventMap = {
  skillsChanged: { count: number };
  mcpsChanged: { count: number };
  headlessProgress: { phase: HeadlessSetupPhase; label: string; error?: string };
  signInProgress: { phase: "awaiting_approval" | "complete" | "error"; error?: string };
  authStateChanged: { signedIn: boolean };
  identityRefreshNeeded: Record<string, never>;
  captureComplete: { source: string };
  profileChanged: { profile: string };
  updateCheckStarted: Record<string, never>;
  updateAvailable: { version: string };
  updateNotAvailable: Record<string, never>;
  updateCheckFailed: { error: string };
  bootstrapRunStarted: { runId: string };
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
  // TODO: temporary bump for bootstrapWorkspaceContext; split into uploadSourceItems + triggerSynthesisRun and poll instead.
  maxRequestTime: 5 * 60_000,
  handlers: {
    requests: {},
    messages: {
      skillsChanged: (data) => events.emit("skillsChanged", data),
      mcpsChanged: (data) => events.emit("mcpsChanged", data),

      headlessProgress: (data) => events.emit("headlessProgress", data),
      signInProgress: (data) => events.emit("signInProgress", data),
      authStateChanged: (data) => events.emit("authStateChanged", data),

      captureComplete: (data) => events.emit("captureComplete", data),

      profileChanged: (data) => events.emit("profileChanged", data),
      updateCheckStarted: (data) => events.emit("updateCheckStarted", data),
      updateAvailable: (data) => events.emit("updateAvailable", data),
      updateNotAvailable: (data) => events.emit("updateNotAvailable", data),
      updateCheckFailed: (data) => events.emit("updateCheckFailed", data),
    },
  },
});

new Electroview({ rpc });
