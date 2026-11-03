import { Fragment, useEffect, useState } from "react";
import { renderMarkdown } from "../context/markdown";
import { MessageActions } from "./MessageActions";
import { messageDomId } from "./share-links";
import { inputStatusLine, isBlocked } from "./input-status";
import { approvalOutcome, isMine, type StreamItem } from "./stream-items";

function formatInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

const SLOW_SEND_MS = 10_000;
const SLOW_TICK_MS = 1_000;

/** Looks like a sent message. A line under it shows only when the message is blocked or has waited long. */
function PendingBubble({ item, mine, harness, onSteer, onCancel, onShowRequest, onSkipQuestions, onDismissPrompt }: { item: Extract<StreamItem, { type: "pending" }>; mine: boolean; harness: string; onSteer?: (inputId: string) => void; onCancel?: (inputId: string) => void; onShowRequest?: () => void; onSkipQuestions?: () => void; onDismissPrompt?: () => void }) {
  const { input } = item;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SLOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const showNote = isBlocked(input, item.hostOffline) || now - Date.parse(input.created_at) >= SLOW_SEND_MS;
  return (
    <>
      {!mine && <span className="ui-stream__who">{item.author}</span>}
      <p className="ui-stream__bubble">{input.text}</p>
      {showNote && <span className="ui-muted ui-stream__pending-note" role="status">{inputStatusLine(input, item.ownerName, now, item.hostOffline, harness)}</span>}
      {onSteer && input.mine && input.state === "queued" && input.reason === "composer_busy" && (
        <button type="button" className="ui-link ui-stream__steer" onClick={() => onSteer(input.id)}>Send now</button>
      )}
      {onSkipQuestions && input.state === "queued" && input.reason === "question_prompt" && (
        <button type="button" className="ui-link ui-stream__steer" onClick={onSkipQuestions}>Send now</button>
      )}
      {onDismissPrompt && input.state === "queued" && (input.reason === "dialog" || input.reason === "permission_prompt" || input.reason === "question_prompt") && (
        <button type="button" className="ui-link ui-stream__steer" onClick={onDismissPrompt}>Dismiss in terminal <kbd className="ui-kbd">Esc</kbd></button>
      )}
      {onShowRequest && input.state === "queued" && input.reason === "permission_prompt" && (
        <button type="button" className="ui-link ui-stream__steer" onClick={onShowRequest}>Review it</button>
      )}
      {onCancel && input.mine && input.state === "queued" && (
        <button type="button" className="ui-link ui-stream__steer" onClick={() => onCancel(input.id)}>Cancel</button>
      )}
    </>
  );
}

function Item({ item, mine, ownerName, hostName, viewerId, linkFor, harness, onSteer, onCancel, onShowRequest, onSkipQuestions, onDismissPrompt }: { item: StreamItem; mine: boolean; ownerName: string; hostName: string | null; viewerId?: string; linkFor?: (seq: number) => string; harness: string; onSteer?: (inputId: string) => void; onCancel?: (inputId: string) => void; onShowRequest?: () => void; onSkipQuestions?: () => void; onDismissPrompt?: () => void }) {
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
          {!mine && <span className="ui-stream__who">{item.authorName ?? item.author ?? ownerName}</span>}
          <p className="ui-stream__bubble">{item.text}</p>
          <MessageActions text={item.text} at={item.at} linkUrl={linkFor?.(item.seq)} />
        </>
      );
    case "pending":
      return <PendingBubble item={item} mine={mine} harness={harness} onSteer={onSteer} onCancel={onCancel} onShowRequest={onShowRequest} onSkipQuestions={onSkipQuestions} onDismissPrompt={onDismissPrompt} />;
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
      if (item.kind === "question" && item.questions.length > 0) {
        const answers = item.resolved?.answers ?? {};
        return (
          <div className="ui-stream__note ui-stream__answers">
            <p>Question · {approvalOutcome(item, hostName)}</p>
            <ul>
              {item.questions.map((q) => (
                <li key={q.key}>
                  <span className="ui-muted">{q.question}</span>
                  {answers[q.key] !== undefined && <strong> {q.isSecret ? "••••" : [answers[q.key]].flat().join(", ")}</strong>}
                </li>
              ))}
            </ul>
          </div>
        );
      }
      return (
        <p className="ui-stream__note">
          {item.tool}
          {item.summary && <> {item.summary}</>}
          {" · "}
          {approvalOutcome(item, hostName)}
        </p>
      );
    case "tool":
      if (item.name === "ExitPlanMode" && typeof (item.input as { plan?: unknown } | null)?.plan === "string") {
        return (
          <details className="ui-stream__details" open>
            <summary><span className="ui-stream__tool">Plan</span></summary>
            <div className="ui-plan__body ui-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown((item.input as { plan: string }).plan) }} />
          </details>
        );
      }
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
  viewerName = "",
  viewerIsOwner = false,
  harness = "claude",
  onSteer,
  onCancel,
  onShowRequest,
  onSkipQuestions,
  onDismissPrompt,
  linkFor,
  highlightSeq = null,
}: {
  items: StreamItem[];
  ownerName?: string;
  hostName?: string | null;
  /** Tells "You interrupted" from "Interrupted by …". */
  viewerId?: string;
  /** With `viewerIsOwner`, tells the viewer's messages from a teammate's. */
  viewerName?: string;
  viewerIsOwner?: boolean;
  /** The agent that runs the session, for the wording of a waiting message. */
  harness?: string;
  /** Puts a waiting message into the running turn. Without it, the Send now action is hidden. */
  onSteer?: (inputId: string) => void;
  onCancel?: (inputId: string) => void;
  onShowRequest?: () => void;
  onSkipQuestions?: () => void;
  onDismissPrompt?: () => void;
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
        const human = !agentId && (item.type === "user" || item.type === "pending");
        const mine = human ? isMine(item, { id: viewerId, name: viewerName, isOwner: viewerIsOwner }) : true;
        return (
          <Fragment key={keyOf(item)}>
            {startsAgent && <li className="ui-stream__agent-label">Sub-agent</li>}
            <li
              id={item.type === "pending" ? undefined : messageDomId(item.seq)}
              className={`ui-stream__item ui-stream__item--${item.type === "pending" ? "user" : item.type}${agentId ? " ui-stream__item--agent" : item.type === "user" || item.type === "pending" ? ` ui-stream__item--human${mine ? "" : " ui-stream__item--theirs"}` : ""}${item.type !== "pending" && item.seq === highlightSeq ? " ui-stream__item--highlight" : ""}`}
            >
              <Item item={item} mine={mine} ownerName={ownerName} hostName={hostName} viewerId={viewerId} linkFor={linkFor} harness={harness} onSteer={onSteer} onCancel={onCancel} onShowRequest={onShowRequest} onSkipQuestions={onSkipQuestions} onDismissPrompt={onDismissPrompt} />
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
