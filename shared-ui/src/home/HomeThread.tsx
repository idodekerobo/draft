"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

type Loaded = { id: string; model: string | null; canReply: boolean };

/**
 * Draft's thread on Home: the person's own agent session, shown by the same view as any session. It starts the session on
 * first use, offers a few prompts to someone who has not spoken, and says plainly when Draft cannot reply.
 */
export function HomeThread({ api, thread, onOpenConnections, onSession, onSeq }: {
  api: LiveSessionsApi;
  thread: HomeThreadApi;
  onOpenConnections: () => void;
  /** Tells the page which session is Home, so an approval row can point at the thread. */
  onSession?: (sessionId: string) => void;
  onSeq?: (seq: number) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [models, setModels] = useState<HomeModel[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    thread.loadSession().then((value) => {
      if (cancelled) return;
      setLoaded(value);
      onSession?.(value.id);
    }).catch(() => !cancelled && setFailed(true));
    thread.loadModels().then((value) => !cancelled && setModels(value)).catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, attempt]);

  const select = useCallback(async (model: string) => {
    if (!loaded) return;
    await api.setMode(loaded.id, { model });
    setLoaded((current) => (current ? { ...current, model } : current));
  }, [api, loaded]);

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
        <p className="ui-error" role="alert">Draft can&apos;t reply right now. <button type="button" className="ui-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
      </section>
    );
  }
  if (!loaded || !home) {
    return (
      <section className="ui-home-thread" aria-label="Draft" aria-busy="true">
        <p className="ui-muted" role="status">Starting Draft…</p>
      </section>
    );
  }
  return (
    <section className="ui-home-thread" aria-label="Draft">
      <SessionView api={api} sessionId={loaded.id} home={home} />
    </section>
  );
}
