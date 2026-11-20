import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "../query";
import { sessionSignalTopic } from "draft-core/live-sessions";
import { Disclosure } from "./view-state";
import { SessionStream } from "./SessionStream";
import { buildStreamItems } from "./stream-items";
import { mergeTranscriptPage, transcriptEvents } from "./transcript-pages";
import { useSignals, SESSION_SAFETY_POLL_MS } from "./signals";
import type { LiveSessionsApi, SessionAgentSummary, SessionTranscriptPage } from "./types";

export const AgentTranscripts = createContext<{
  api: LiveSessionsApi;
  sessionId: string;
  cacheKey: readonly string[];
  target: number | null;
  mounted(): void;
  linkFor?: (seq: number) => string;
  harness: string;
  ownerName: string;
  hostName: string | null;
  viewerId: string;
  viewerName: string;
  viewerIsOwner: boolean;
} | null>(null);

export function AgentPanel({ agent, seq, children }: { agent: SessionAgentSummary; seq: number; children?: ReactNode }) {
  return <Disclosure seq={agent.key} aliases={[seq, `spawn:${agent.hostSeq}`]} summary={<>
    <span className="ui-stream__tool">Agent</span>
    {agent.name && <span className="ui-stream__summary">@{agent.name} </span>}
    {agent.description && <span className="ui-stream__summary ui-stream__summary--title">{agent.description}</span>}
    <span className="ui-muted"> · {agent.isError ? "failed" : agent.async && agent.state === "idle" ? "completed" : agent.state} · {agent.steps} {agent.steps === 1 ? "step" : "steps"}</span>
  </>}>
    {() => <>{agent.agentId ? <AgentTranscript agent={agent} /> : <p className="ui-muted">Waiting for the agent transcript…</p>}{children}</>}
  </Disclosure>;
}

function AgentTranscript({ agent }: { agent: SessionAgentSummary }) {
  const runtime = useContext(AgentTranscripts)!;
  const client = useQueryClient();
  const key = useMemo(() => [...runtime.cacheKey, "agent", agent.agentId!], [runtime.cacheKey, agent.agentId]);
  const active = useRef(true);
  const busy = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const restore = useRef<{ seq: string; top: number } | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [followLatest, setFollowLatest] = useState(false);
  const focusKey = useMemo(() => [...runtime.cacheKey, "agent-window", agent.agentId!, String(runtime.target)], [runtime.cacheKey, agent.agentId, runtime.target]);
  const focused = !followLatest && runtime.target !== null ? client.getQueryData<SessionTranscriptPage>(focusKey) : undefined;
  useEffect(() => { setFollowLatest(false); }, [runtime.target]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<SessionTranscriptPage> => {
      const previous = client.getQueryData<SessionTranscriptPage>(key);
      const response = await runtime.api.fetchView!(runtime.sessionId, { agentId: agent.agentId!, state: false, ...(previous ? { after: previous.readThrough } : {}) });
      let page = mergeTranscriptPage(previous, response.page);
      while (page.hasNewer && active.current) {
        client.setQueryData(key, page);
        const next = await runtime.api.fetchView!(runtime.sessionId, { agentId: agent.agentId!, after: page.readThrough, through: page.through, state: false });
        if (next.page.readThrough <= page.readThrough && next.page.hasNewer) throw new Error("Agent cursor did not advance");
        page = mergeTranscriptPage(page, next.page);
      }
      const current = client.getQueryData<SessionTranscriptPage>(key);
      return mergeTranscriptPage(current, page);
    },
    staleTime: 0, refetchInterval: SESSION_SAFETY_POLL_MS,
  });
  useSignals(runtime.api.watchSignals, sessionSignalTopic(runtime.sessionId), async () => void await query.refetch({ cancelRefetch: false }));
  const visible = focused ?? query.data;
  const items = useMemo(() => visible ? buildStreamItems(transcriptEvents(visible), true) : [], [visible]);
  useLayoutEffect(() => {
    if (restore.current && scroll.current) {
      const anchor = scroll.current.querySelector<HTMLElement>(`#${restore.current.seq}`);
      if (anchor) scroll.current.scrollTop += anchor.getBoundingClientRect().top - restore.current.top;
      restore.current = null;
    }
    runtime.mounted();
  }, [items, runtime.mounted]);
  const older = async () => {
    const page = visible;
    if (!page?.hasOlder || page.before === null || busy.current) return;
    busy.current = true; setOlderLoading(true); setOlderError(false);
    const anchor = Array.from(scroll.current?.querySelectorAll<HTMLElement>(".ui-stream__item[id]") ?? []).find((el) => el.getBoundingClientRect().bottom > scroll.current!.getBoundingClientRect().top);
    try {
      const response = await client.fetchQuery({ queryKey: [...key, "older", String(page.before)],
        queryFn: () => runtime.api.fetchView!(runtime.sessionId, { agentId: agent.agentId!, before: page.before!, through: page.through, state: false }), staleTime: Infinity });
      if (anchor && active.current) restore.current = { seq: anchor.id, top: anchor.getBoundingClientRect().top };
      client.setQueryData<SessionTranscriptPage>(focused ? focusKey : key, (current) => mergeTranscriptPage(current ?? page, response.page, "older"));
    } catch { if (active.current) setOlderError(true); }
    finally { busy.current = false; if (active.current) setOlderLoading(false); }
  };
  if (query.isPending && !visible) return <p className="ui-muted" role="status">Loading agent messages…</p>;
  if (query.isError && !visible) return <p role="alert">Could not load agent messages. <button className="ui-link" onClick={() => void query.refetch()}>Retry</button></p>;
  return <div ref={scroll} className="ui-stream__agent-scroll" style={{ maxHeight: "60vh", overflowY: "auto" }} tabIndex={0} aria-label="Agent messages"
    onScroll={() => { if (scroll.current && scroll.current.scrollTop > 0 && scroll.current.scrollTop < 200) void older(); }}>
    {focused && <button className="ui-link" onClick={() => setFollowLatest(true)}>Jump to latest agent messages</button>}
    {visible?.hasOlder && <button className="ui-link" disabled={olderLoading} onClick={() => void older()}>{olderLoading ? "Loading…" : "Load older messages"}</button>}
    {olderError && <p role="alert">Could not load older messages. <button className="ui-link" onClick={() => void older()}>Retry</button></p>}
    {query.isError && query.data && <p role="status">Agent updates are delayed. <button className="ui-link" onClick={() => void query.refetch()}>Retry</button></p>}
    <SessionStream items={items} highlightSeq={runtime.target} harness={runtime.harness} linkFor={runtime.linkFor} ownerName={runtime.ownerName} hostName={runtime.hostName} viewerId={runtime.viewerId} viewerName={runtime.viewerName} viewerIsOwner={runtime.viewerIsOwner} />
  </div>;
}
