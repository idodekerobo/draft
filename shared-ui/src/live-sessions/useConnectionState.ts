"use client";

import { useEffect, useState } from "react";
import type { LiveSessionsApi } from "./types";

export type ConnectionState = "live" | "reconnecting" | "offline";

/** A short drop is not worth a word, so "reconnecting" waits this long. */
export const RECONNECTING_AFTER_MS = 3_000;

/** What to tell the viewer about the live connection. Apps without signals are always `live`. */
export function connectionState(input: { watched: boolean; connected: boolean; slow: boolean; online: boolean }): ConnectionState {
  if (!input.watched) return "live";
  if (!input.online) return "offline";
  return input.connected || !input.slow ? "live" : "reconnecting";
}

export function useConnectionState(api: LiveSessionsApi, afterMs = RECONNECTING_AFTER_MS): ConnectionState {
  const [connected, setConnected] = useState(true);
  const [slow, setSlow] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (!api.watchConnection) return;
    return api.watchConnection(setConnected);
  }, [api]);

  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (connected) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [connected, afterMs]);

  return connectionState({ watched: Boolean(api.watchConnection), connected, slow, online });
}
