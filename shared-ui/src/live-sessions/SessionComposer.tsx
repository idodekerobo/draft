"use client";

import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { inputStatusLine } from "./input-status";
import type { SessionInputsState } from "./useSessionInputs";

const MAX_CHARS = 10_000;
const STATUS_TICK_MS = 30_000;

const SEND_ERRORS: Record<string, string> = {
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
  folderName,
}: SessionInputsState & { ownerName: string; ended: boolean; folderName?: string | null }) {
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
      setError(SEND_ERRORS[code] ?? "Could not send. Try again.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
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
              <span className={input.state === "failed" ? "ui-error" : "ui-muted"}>{inputStatusLine(input, ownerName, now)}</span>
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
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
              </svg>
              <span>{folderName}</span>
            </div>
          )}
          <div className="ui-composer__row">
          <label className="ui-visually-hidden" htmlFor="session-message">Message to {ownerName}'s session</label>
          <textarea
            id="session-message"
            className="ui-composer__input"
            rows={2}
            maxLength={MAX_CHARS}
            placeholder={`Message ${ownerName}'s session`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
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
