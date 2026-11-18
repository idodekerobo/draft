"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import type { StreamItem } from "./stream-items";

export interface SessionViewState {
  expanded: Readonly<Record<number, boolean>>;
  scroll: number | null;
}

export class SessionViewStates {
  private viewer: string | null = null;

  setViewer(viewer: string) {
    if (this.viewer !== viewer) this.sessions.clear();
    this.viewer = viewer;
  }

  private sessions = new Map<string, SessionViewState>();

  get(id: string): SessionViewState {
    const state = this.sessions.get(id) ?? { expanded: {}, scroll: null };
    this.sessions.delete(id);
    this.sessions.set(id, state);
    if (this.sessions.size > 20) this.sessions.delete(this.sessions.keys().next().value!);
    return state;
  }

  delete(id: string) { this.sessions.delete(id); }

  deleteSession(sessionId: string) {
    for (const key of this.sessions.keys()) {
      if (key.endsWith(`:${sessionId}`)) this.sessions.delete(key);
    }
  }
}

const ViewStates = createContext<SessionViewStates | null>(null);
const standaloneStates = new SessionViewStates();
const fallbackStates = new WeakMap<QueryClient, SessionViewStates>();

export function SessionViewStateProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const states = useMemo(() => new SessionViewStates(), [scope]);
  return <ViewStates.Provider key={scope} value={states}>{children}</ViewStates.Provider>;
}

export function useSessionViewStates(): SessionViewStates {
  const provided = useContext(ViewStates);
  const client = useContext(QueryClientContext);
  if (provided) return provided;
  if (!client) return standaloneStates;
  let states = fallbackStates.get(client);
  if (!states) fallbackStates.set(client, states = new SessionViewStates());
  return states;
}

export const viewStateKey = (sessionId: string, viewerId: string) => `${viewerId}:${sessionId}`;

export function revealPath(items: StreamItem[], seq: number, parents: number[] = []): number[] | null {
  for (const item of items) {
    if (item.type === "pending" || item.type === "live") continue;
    if (item.seq === seq) return [...parents, item.seq];
    if (item.type === "tool" && item.children) {
      const path = revealPath(item.children, seq, [...parents, item.seq]);
      if (path) return path;
    }
  }
  return null;
}

export const DisclosureState = createContext<{
  expanded: Readonly<Record<number, boolean>>;
  change(seq: number, open: boolean): void;
} | null>(null);

export function Disclosure({ seq, initiallyOpen = false, summary, children }: {
  seq: number;
  initiallyOpen?: boolean;
  summary: ReactNode;
  children: () => ReactNode;
}) {
  const state = useContext(DisclosureState);
  const [localOpen, setLocalOpen] = useState(initiallyOpen);
  const open = state?.expanded[seq] ?? localOpen;
  return (
    <details className="ui-stream__details" open={open} onToggle={(event) => {
      if (event.target !== event.currentTarget) return;
      const next = event.currentTarget.open;
      if (next === open) return;
      if (state) state.change(seq, next);
      else setLocalOpen(next);
    }}>
      <summary>{summary}</summary>
      {open && children()}
    </details>
  );
}
