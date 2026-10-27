"use client";

import { useEffect, useState } from "react";
import type { LiveSessionViewer, LiveSessionsApi } from "./types";

const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((name, i) => name === b[i]);

/** Names of the other people watching this session, or none where the app has no presence. */
export function useSessionPresence(api: LiveSessionsApi, sessionId: string, viewer: LiveSessionViewer): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    setNames([]);
    if (!api.watchPresence) return;
    return api.watchPresence(sessionId, { id: viewer.id, name: viewer.name }, (next) => setNames((current) => (sameNames(current, next) ? current : next)));
  }, [api, sessionId, viewer.id, viewer.name]);
  return names;
}
