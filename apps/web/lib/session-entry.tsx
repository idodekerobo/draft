"use client";

import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import type { SessionEntry } from "draft-shared-ui";

interface SessionEntryValue {
  /** "direct" only for the session the page was loaded on, until the person navigates inside the app. */
  entryFor: (sessionId: string) => SessionEntry;
  markInAppNavigation: () => void;
}

const SessionEntryContext = createContext<SessionEntryValue>({ entryFor: () => "list", markInAppNavigation: () => {} });

/** Lives in the sessions layout, which stays mounted while the person moves between sessions. */
export function SessionEntryProvider({ firstSessionId, children }: { firstSessionId: string | null; children: ReactNode }) {
  const first = useRef(firstSessionId);
  const navigated = useRef(false);
  const markInAppNavigation = useCallback(() => {
    navigated.current = true;
  }, []);
  const value = useMemo<SessionEntryValue>(
    () => ({ entryFor: (sessionId) => (!navigated.current && first.current === sessionId ? "direct" : "list"), markInAppNavigation }),
    [markInAppNavigation],
  );
  return <SessionEntryContext.Provider value={value}>{children}</SessionEntryContext.Provider>;
}

export const useSessionEntry = () => useContext(SessionEntryContext);
