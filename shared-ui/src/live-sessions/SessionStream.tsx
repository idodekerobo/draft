import { Fragment } from "react";
import { renderMarkdown } from "../context/markdown";
import { approvalOutcome, type StreamItem } from "./stream-items";

function formatInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

function Item({ item, ownerName, hostName }: { item: StreamItem; ownerName: string; hostName: string | null }) {
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
        </>
      );
    case "assistant":
      return <div className="ui-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />;
    case "thinking":
      return (
        <details className="ui-stream__details">
          <summary>Thinking</summary>
          <p className="ui-stream__text ui-muted">{item.text}</p>
        </details>
      );
    case "note":
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

const agentOf = (item: StreamItem) => ("agentId" in item ? item.agentId : null);

/** Open requests are shown in the approval panel, not in the stream. */
export function SessionStream({ items: all, ownerName = "User", hostName = null }: { items: StreamItem[]; ownerName?: string; hostName?: string | null }) {
  const items = all.filter((item) => item.type !== "approval" || item.resolved !== null);
  if (items.length === 0) return <p className="ui-muted" role="status">Waiting for the first message…</p>;

  return (
    <ol className="ui-stream">
      {items.map((item, index) => {
        const agentId = agentOf(item);
        const previous = index > 0 ? agentOf(items[index - 1]!) : null;
        const startsAgent = agentId !== null && previous !== agentId;
        return (
          <Fragment key={item.seq}>
            {startsAgent && <li className="ui-stream__agent-label">Sub-agent</li>}
            <li className={`ui-stream__item ui-stream__item--${item.type}${agentId ? " ui-stream__item--agent" : item.type === "user" ? " ui-stream__item--human" : ""}`}>
              <Item item={item} ownerName={ownerName} hostName={hostName} />
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
