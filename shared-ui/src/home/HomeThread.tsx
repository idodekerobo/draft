"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { SessionView } from "../live-sessions/SessionView";
import type { LiveSessionsApi } from "../live-sessions/types";
import { HomeModelPicker, type HomeModel } from "./HomeModelPicker";

/** What the thread needs from the app besides the live session api. */
export interface HomeThreadApi {
  /** The person's own Home session, made on first use, and whether Draft can reply now. */
  loadSession(): Promise<{ id: string; model: string | null; canReply: boolean }>;
  loadModels(): Promise<HomeModel[]>;
}

const SUGGESTIONS = ["What needs me right now?", "What happened on my team this week?", "Help me follow up on my latest meeting"] as const;

const HOME_STALE_MS = 5 * 60_000;

type Loaded = { id: string; model: string | null; canReply: boolean };

/**
 * Draft's thread on Home: the person's own agent session, shown by the same view as any session. It starts the session on
 * first use, offers a few prompts to someone who has not spoken, and says plainly when Draft cannot reply.
 */
export function HomeThread({ api, thread, workspaceId, onOpenConnections, onSession, onSeq }: {
  api: LiveSessionsApi;
  thread: HomeThreadApi;
  workspaceId: string;
  onOpenConnections: () => void;
  /** Tells the page which session is Home, so an approval row can point at the thread. */
  onSession?: (sessionId: string) => void;
  onSeq?: (seq: number) => void;
}) {
  // Kept in the query cache, so coming back to Home shows the thread at once and refreshes it in the background.
  const client = useQueryClient();
  const sessionKey = useMemo(() => ["home-thread", workspaceId, "session"] as const, [workspaceId]);
  const session = useQuery({ queryKey: sessionKey, queryFn: () => thread.loadSession(), staleTime: HOME_STALE_MS });
  const modelsQuery = useQuery({ queryKey: ["home-thread", workspaceId, "models"], queryFn: () => thread.loadModels(), staleTime: HOME_STALE_MS });
  const loaded: Loaded | null = session.data ?? null;
  const models = modelsQuery.data ?? [];
  const failed = session.isError && !loaded;

  useEffect(() => {
    if (loaded) onSession?.(loaded.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.id]);

  const select = useCallback(async (model: string) => {
    if (!loaded) return;
    await api.setMode(loaded.id, { model });
    client.setQueryData<Loaded>(sessionKey, (current) => (current ? { ...current, model } : current));
  }, [api, loaded, client, sessionKey]);

  const home = useMemo(() => {
    if (!loaded) return null;
    return {
      suggestions: SUGGESTIONS,
      placeholder: "Ask Draft…",
      onSeq,
      modelControl: <HomeModelPicker models={models} value={loaded.model} onSelect={select} />,
      notice: loaded.canReply ? undefined : (
        <>
          Draft can&apos;t reply right now. The workspace&apos;s Claude login needs to be connected.{" "}
          <button type="button" className="ui-link" onClick={onOpenConnections}>Reconnect</button>
        </>
      ),
    };
  }, [loaded, models, select, onSeq, onOpenConnections]);

  if (failed) {
    return (
      <section className="ui-home-thread" aria-label="Draft">
        <p className="ui-error" role="alert">Draft can&apos;t reply right now. <button type="button" className="ui-link" onClick={() => void session.refetch()}>Try again</button></p>
      </section>
    );
  }
  if (!loaded || !home) {
    return (
      <section className="ui-home-thread" aria-label="Draft" aria-busy="true">
        <header className="ui-session__header ui-session__header--home">
          <h2 className="ui-session__title">Draft</h2>
        </header>
        <div className="ui-home-thread__skeleton" role="status" aria-label="Loading your conversation with Draft">
          <span className="ui-skeleton ui-skeleton--line" style={{ width: "58%" }} />
          <span className="ui-skeleton ui-skeleton--line" style={{ width: "82%" }} />
          <span className="ui-skeleton ui-skeleton--line" style={{ width: "44%" }} />
        </div>
        <div className="ui-home-thread__skeleton-composer" aria-hidden="true" />
      </section>
    );
  }
  return (
    <section className="ui-home-thread" aria-label="Draft">
      <SessionView api={api} sessionId={loaded.id} home={home} />
    </section>
  );
}
