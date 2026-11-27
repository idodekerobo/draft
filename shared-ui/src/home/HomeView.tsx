"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LiveSessionsApi } from "../live-sessions/types";
import { HomeThread, type HomeThreadApi } from "./HomeThread";
import { NeedsYouPanel, type NeedsYouPanelProps } from "./NeedsYouPanel";

export interface HomeViewProps extends NeedsYouPanelProps {
  /** Draft's thread. Without it Home shows only what needs the person. */
  thread?: { api: LiveSessionsApi; home: HomeThreadApi };
}

type Tab = "needs" | "chat";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "needs", label: "Needs you" },
  { id: "chat", label: "Chat" },
];

/**
 * Home: what needs the person, and Draft's thread. On a wide screen both show, Needs you above the thread. On a phone a tab
 * list shows one at a time, with a dot on Chat when Draft wrote something while the person was on Needs you.
 */
export function HomeView({ thread, ...props }: HomeViewProps) {
  const [tab, setTab] = useState<Tab>("needs");
  const [homeId, setHomeId] = useState<string | null>(null);
  const [latestSeq, setLatestSeq] = useState<number | null>(null);
  const seenSeq = useRef<number | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ needs: null, chat: null });

  const onSeq = useCallback((seq: number) => setLatestSeq(seq), []);
  // What the person has seen: everything at the first load, and everything while Chat is the tab in view.
  useEffect(() => {
    if (latestSeq === null) return;
    if (seenSeq.current === null || tab === "chat") seenSeq.current = latestSeq;
  }, [latestSeq, tab]);
  const unread = tab !== "chat" && latestSeq !== null && seenSeq.current !== null && latestSeq > seenSeq.current;

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((item) => item.id === tab);
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next]!.id;
    setTab(target);
    tabRefs.current[target]?.focus();
  }

  // An approval for Draft's own question points at the thread, where its card is, not at another page.
  const openSession = (sessionId: string) => {
    if (thread && sessionId === homeId) {
      setTab("chat");
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".ui-session--home .ui-approval button, .ui-session--home .ui-question button")?.focus());
      return;
    }
    props.onOpenSession(sessionId);
  };

  return (
    <div className="ui-home" data-tab={tab}>
      <h1 className="ui-page__title">Home</h1>
      {thread && (
        <div className="ui-home__tabs" role="tablist" aria-label="Home" onKeyDown={onKey}>
          {TABS.map((item) => (
            <button
              key={item.id}
              ref={(element) => { tabRefs.current[item.id] = element; }}
              type="button"
              role="tab"
              id={`home-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`home-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className="ui-home__tab"
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.id === "chat" && unread && <span className="ui-home__dot" role="img" aria-label="New from Draft" />}
            </button>
          ))}
        </div>
      )}
      <div className="ui-home__panel ui-home__panel--needs" id="home-panel-needs" role={thread ? "tabpanel" : undefined} aria-labelledby={thread ? "home-tab-needs" : undefined}>
        <NeedsYouPanel {...props} onOpenSession={openSession} />
      </div>
      {thread && (
        <div className="ui-home__panel ui-home__panel--chat" id="home-panel-chat" role="tabpanel" aria-labelledby="home-tab-chat">
          <HomeThread api={thread.api} thread={thread.home} workspaceId={props.workspaceId} onOpenConnections={props.onOpenConnections} onSession={setHomeId} onSeq={onSeq} />
        </div>
      )}
    </div>
  );
}
