import { Fragment, useEffect, useState } from "react";
import { renderMarkdown } from "../context/markdown";
import { MessageActions } from "./MessageActions";
import { messageDomId } from "./share-links";
import { inputStatusLine, isBlocked } from "./input-status";
import { approvalOutcome, type StreamItem } from "./stream-items";

function formatInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

const SLOW_SEND_MS = 10_000;
const SLOW_TICK_MS = 1_000;

/** Looks like a sent message. A line under it shows only when the message is blocked or has waited long. */
function PendingBubble({ item }: { item: Extract<StreamItem, { type: "pending" }> }) {
  const { input } = item;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SLOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const showNote = isBlocked(input, item.hostOffline) || now - Date.parse(input.created_at) >= SLOW_SEND_MS;
  return (
    <>
      <span className="ui-stream__who">{item.author}</span>
      <p className="ui-stream__bubble">{input.text}</p>
      {showNote && <span className="ui-muted ui-stream__pending-note" role="status">{inputStatusLine(input, item.ownerName, now, item.hostOffline)}</span>}
    </>
  );
}

function Item({ item, ownerName, hostName, viewerId, linkFor }: { item: StreamItem; ownerName: string; hostName: string | null; viewerId?: string; linkFor?: (seq: number) => string }) {
  switch (item.type) {
    case "user":
      if (item.agentId) {
        return (
          <>
            <span className="ui-stream__who">Prompt</span>
            <p className="ui-stream__text">{item.text}</p>
          </>
        );
      }
      return (
        <>
          <span className="ui-stream__who">{item.author ?? ownerName}</span>
          <p className="ui-stream__bubble">{item.text}</p>
          <MessageActions text={item.text} at={item.at} linkUrl={linkFor?.(item.seq)} />
        </>
      );
    case "pending":
      return <PendingBubble item={item} />;
    case "assistant":
      return (
        <>
          <div className="ui-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
          <MessageActions text={item.text} at={item.at} linkUrl={linkFor?.(item.seq)} />
        </>
      );
    case "thinking":
      return (
        <details className="ui-stream__details">
          <summary>Thinking</summary>
          <p className="ui-stream__text ui-muted">{item.text}</p>
        </details>
      );
    case "note":
      if (item.interruptedBy) {
        const mine = item.interruptedBy.id === viewerId;
        return <p className="ui-stream__note ui-stream__note--interrupted">{mine ? "You interrupted" : `Interrupted by ${item.interruptedBy.name}`}</p>;
      }
      return <p className="ui-stream__note">{item.text}</p>;
    case "approval":
      return (
        <p className="ui-stream__note">
          {item.tool}
          {item.summary && <> {item.summary}</>}
          {" · "}
          {approvalOutcome(item, hostName)}
        </p>
      );
    case "tool":
      return (
        <details className="ui-stream__details">
          <summary>
            <span className="ui-stream__tool">{item.name}</span>
            {item.summary && <span className="ui-stream__summary">{item.summary}</span>}
            {item.result === null && <span className="ui-muted"> · running</span>}
            {item.result?.isError && <span className="ui-error"> · failed</span>}
          </summary>
          <pre className="ui-stream__code">{formatInput(item.input)}</pre>
          {item.result && (
            <pre className={`ui-stream__code${item.result.isError ? " ui-stream__code--error" : ""}`}>
              {item.result.text || "(no output)"}
              {item.result.truncated ? "\n… output clipped" : ""}
            </pre>
          )}
        </details>
      );
  }
}

const keyOf = (item: StreamItem) => (item.type === "pending" ? `pending-${item.key}` : item.seq);
const agentOf = (item: StreamItem) => ("agentId" in item ? item.agentId : null);

/** Open requests are shown in the approval panel, not in the stream. */
export function SessionStream({
  items: all,
  ownerName = "User",
  hostName = null,
  viewerId,
  linkFor,
  highlightSeq = null,
}: {
  items: StreamItem[];
  ownerName?: string;
  hostName?: string | null;
  /** Tells "You interrupted" from "Interrupted by …". */
  viewerId?: string;
  /** Builds the link to one message. Without it, the link action is hidden. */
  linkFor?: (seq: number) => string;
  highlightSeq?: number | null;
}) {
  const items = all.filter((item) => item.type !== "approval" || item.resolved !== null);
  if (items.length === 0) return <p className="ui-muted" role="status">Waiting for the first message…</p>;

  return (
    <ol className="ui-stream">
      {items.map((item, index) => {
        const agentId = agentOf(item);
        const previous = index > 0 ? agentOf(items[index - 1]!) : null;
        const startsAgent = agentId !== null && previous !== agentId;
        return (
          <Fragment key={keyOf(item)}>
            {startsAgent && <li className="ui-stream__agent-label">Sub-agent</li>}
            <li
              id={item.type === "pending" ? undefined : messageDomId(item.seq)}
              className={`ui-stream__item ui-stream__item--${item.type === "pending" ? "user" : item.type}${agentId ? " ui-stream__item--agent" : item.type === "user" || item.type === "pending" ? " ui-stream__item--human" : ""}${item.type !== "pending" && item.seq === highlightSeq ? " ui-stream__item--highlight" : ""}`}
            >
              <Item item={item} ownerName={ownerName} hostName={hostName} viewerId={viewerId} linkFor={linkFor} />
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
