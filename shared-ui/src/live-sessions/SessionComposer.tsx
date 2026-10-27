"use client";

import { MAX_INPUT_CHARS, type LiveSessionErrorCode } from "draft-core/live-sessions";
import { useEffect, useState, type FormEvent } from "react";
import { inputStatusLine } from "./input-status";
import { FolderIcon, submitOnEnter } from "./message-box";
import type { SessionInputsState } from "./useSessionInputs";

const STATUS_TICK_MS = 30_000;

const SEND_ERRORS: Partial<Record<LiveSessionErrorCode, string>> = {
  session_ended: "This session has ended.",
  queue_full: "Too many messages are waiting. Try again soon.",
  message_too_long: "This message is too long.",
};

export function SessionComposer({
  inputs,
  send,
  act,
  ownerName,
  ended,
  hostOffline = false,
  folderName,
  autoFocus = false,
  onEmptyEscape,
}: SessionInputsState & { ownerName: string; ended: boolean; hostOffline?: boolean; folderName?: string | null; autoFocus?: boolean; onEmptyEscape?: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STATUS_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      await send(message);
      setText("");
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "";
      setError(SEND_ERRORS[code as LiveSessionErrorCode] ?? "Could not send. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="ui-composer">
      {inputs.length > 0 && (
        <ul className="ui-composer__pending" aria-live="polite">
          {inputs.map((input) => (
            <li key={input.id} className="ui-composer__pending-item">
              <span className="ui-composer__author">{input.mine ? "You" : input.author_name}</span>
              <span className="ui-composer__text">{input.text}</span>
              <span className={input.state === "failed" ? "ui-error" : "ui-muted"}>{inputStatusLine(input, ownerName, now, hostOffline)}</span>
              {input.mine && (input.state === "uncertain" || input.state === "failed") && (
                <span className="ui-composer__actions">
                  <button type="button" className="ui-link" onClick={() => void act(input.id, "resend")}>Resend</button>
                  <button type="button" className="ui-link" onClick={() => void act(input.id, "dismiss")}>Dismiss</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {ended ? (
        <p className="ui-muted">This session has ended.</p>
      ) : (
        <form className="ui-composer__box" onSubmit={submit}>
          {folderName && (
            <div className="ui-composer__folder">
              <FolderIcon />
              <span>{folderName}</span>
            </div>
          )}
          <div className="ui-composer__row">
          <label className="ui-visually-hidden" htmlFor="session-message">Message to {ownerName}'s session</label>
          <textarea
            id="session-message"
            className="ui-composer__input"
            rows={2}
            autoFocus={autoFocus}
            maxLength={MAX_INPUT_CHARS}
            placeholder={`Message ${ownerName}'s session`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !text && onEmptyEscape) onEmptyEscape();
              else submitOnEnter(() => void submit())(event);
            }}
          />
          <button type="submit" className="ui-btn ui-btn--primary" disabled={sending || !text.trim()}>
            {sending ? "Sending…" : "Send"}
          </button>
          </div>
        </form>
      )}
      {error && <p className="ui-error" role="alert">{error}</p>}
    </div>
  );
}
