"use client";

import { useEffect, useRef } from "react";
import type { NeedsYouRow as Row } from "./types";

export interface RowHandlers {
  busy: boolean;
  onDone: (notificationId: string) => void;
  onDecide: (personId: string, rowId: string, decision: "approve" | "reject") => void;
  onNotMine: (notificationId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenConnections: () => void;
}

function label(row: Row): { tag: string; text: string; detail?: string } {
  switch (row.kind) {
    case "approval": return { tag: "Approval", text: `${row.title ?? "A session"} is waiting for ${row.openCount === 1 ? "an approval" : `${row.openCount} approvals`}` };
    case "input_request": return { tag: "Question", text: row.question };
    case "connection_attention": return { tag: "Reconnect", text: `${row.provider.charAt(0).toUpperCase()}${row.provider.slice(1)} stopped working`, detail: "Reconnect it so new meetings keep coming in." };
    case "failed_delivery": return { tag: "Failed send", text: `${row.channel === "email" ? "Email" : row.channel} to someone failed: ${row.subject}` };
    case "notification": {
      const { notification } = row;
      const tag = notification.kind === "todo_routed" ? "To-do" : notification.kind === "identity_proposed" ? "Teammate" : notification.kind === "todo_reassign" ? "Reassign" : "Action";
      return { tag, text: notification.subject, detail: notification.text };
    }
  }
}

/** One thing that needs the person, with the actions that fit its kind. */
export function NeedsYouRow({ row, handlers, highlighted = false, leaving = false }: { row: Row; handlers: RowHandlers; highlighted?: boolean; leaving?: boolean }) {
  const { tag, text, detail } = label(row);
  const { busy } = handlers;
  const element = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (highlighted) element.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  return (
    <li ref={element} className={`ui-home-row${leaving ? " ui-home-row--leaving" : ""}`} data-kind={row.kind} aria-current={highlighted ? "true" : undefined} data-highlighted={highlighted ? "true" : undefined}>
      <span className="ui-home-row__tag">{tag}</span>
      <div className="ui-home-row__text">
        <span className="ui-home-row__title">{text}</span>
        {detail && <span className="ui-home-row__detail">{detail}</span>}
      </div>
      <div className="ui-home-row__actions">
        {row.kind === "notification" && row.notification.kind === "todo_routed" && (
          <>
            <button type="button" className="ui-btn ui-btn--primary" disabled={busy} aria-busy={busy} aria-label={`Done: ${row.notification.subject}`} onClick={() => handlers.onDone(row.notification.id)}>{busy ? "Saving…" : "Done"}</button>
            <button type="button" className="ui-link" disabled={busy} aria-label={`Not mine: ${row.notification.subject}`} onClick={() => handlers.onNotMine(row.notification.id)}>Not mine</button>
          </>
        )}
        {row.kind === "notification" && row.notification.kind === "identity_proposed" && row.notification.refType === "person" && row.notification.refId && (
          <>
            <button type="button" className="ui-btn ui-btn--primary" disabled={busy} aria-busy={busy} aria-label={`Approve: ${row.notification.subject}`} onClick={() => handlers.onDecide(row.notification.refId!, row.notification.id, "approve")}>{busy ? "Saving…" : "Approve"}</button>
            <button type="button" className="ui-link" disabled={busy} aria-label={`Reject: ${row.notification.subject}`} onClick={() => handlers.onDecide(row.notification.refId!, row.notification.id, "reject")}>Reject</button>
          </>
        )}
        {row.kind === "notification" && row.notification.kind !== "todo_routed" && !(row.notification.kind === "identity_proposed" && row.notification.refType === "person") && (
          <button type="button" className="ui-btn ui-btn--primary" disabled={busy} aria-busy={busy} aria-label={`Done: ${row.notification.subject}`} onClick={() => handlers.onDone(row.notification.id)}>{busy ? "Saving…" : "Done"}</button>
        )}
        {row.kind === "approval" && <button type="button" className="ui-btn ui-btn--primary" onClick={() => handlers.onOpenSession(row.sessionId)}>Review</button>}
        {row.kind === "input_request" && <button type="button" className="ui-btn ui-btn--primary" onClick={() => handlers.onOpenRun(row.runId)}>Answer</button>}
        {row.kind === "connection_attention" && <button type="button" className="ui-btn ui-btn--primary" onClick={handlers.onOpenConnections}>Reconnect</button>}
      </div>
    </li>
  );
}
