"use client";

import { MAX_INPUT_CHARS, type LiveSessionErrorCode } from "draft-core/live-sessions";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { clearDraft, hasDraft, useDraft } from "./drafts";
import { inputStatusLine, type HostWait } from "./input-status";
import { submitOnEnter, useAutoGrow } from "./message-box";
import type { SessionInputsState } from "./useSessionInputs";
import { useTypeToFocus } from "./useTypeToFocus";

const STATUS_TICK_MS = 30_000;

const SEND_ERRORS: Partial<Record<LiveSessionErrorCode, string>> = {
  session_ended: "This session has ended.",
  queue_full: "Too many messages are waiting. Try again soon.",
  message_too_long: "This message is too long.",
};

/** "This session has ended", with Resume where the owner can continue it. */
function EndedNote({ onResume, pending = false, failure, retryable = true }: { onResume?: () => Promise<void>; pending?: boolean; failure?: string | null; retryable?: boolean }) {
  const [localPending, setResuming] = useState(false);
  const resuming = pending || localPending;
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    if (!onResume || resuming) return;
    setResuming(true);
    setError(null);
    try {
      await onResume();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : "Could not resume the session.");
    } finally {
      setResuming(false);
    }
  }

  return (
    <>
      <p className="ui-muted">
        {resuming ? "Resuming this session…" : "This session has ended."}
        {onResume && (
          <>
            {" "}
            <button type="button" className="ui-link" disabled={resuming} onClick={() => void resume()}>{resuming ? "Resuming…" : failure || error ? retryable ? "Retry resume" : "Resume after fixing" : "Resume"}</button>
          </>
        )}
      </p>
      {(failure || error) && !resuming && <p className="ui-error" role="alert">{failure || error}</p>}
    </>
  );
}

export function SessionComposer({
  sessionId,
  inputs,
  send,
  act,
  ownerName,
  ended,
  resuming = false,
  resumeFailure,
  resumeRetryable = true,
  preserveDraft = false,
  hostWait = false,
  autoFocus = false,
  onEmptyEscape,
  onResume,
  modeControl,
  agentControl,
  onCycleMode,
  sleeping = false,
}: SessionInputsState & { sessionId: string; ownerName: string; ended: boolean; resuming?: boolean; resumeFailure?: string | null; resumeRetryable?: boolean; preserveDraft?: boolean; hostWait?: HostWait; sleeping?: boolean; autoFocus?: boolean; onEmptyEscape?: () => void; onResume?: () => Promise<void>; modeControl?: ReactNode; agentControl?: ReactNode; onCycleMode?: () => void }) {
  const [text, setText] = useDraft(sessionId);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, text);
  useTypeToFocus(inputRef, !ended);

  useEffect(() => {
    if (ended && !preserveDraft) clearDraft(sessionId);
  }, [ended, sessionId, preserveDraft]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STATUS_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = text.trim();
    if (!message) return;
    setError(null);
    setText("");
    try {
      await send(message);
    } catch (failure) {
      if (!hasDraft(sessionId)) setText(message);
      const code = failure instanceof Error ? failure.message : "";
      setError(SEND_ERRORS[code as LiveSessionErrorCode] ?? "Could not send. Try again.");
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
              <span className={input.state === "failed" ? "ui-error" : "ui-muted"}>{inputStatusLine(input, ownerName, now, hostWait)}</span>
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
        <EndedNote onResume={onResume} pending={resuming} failure={resumeFailure} retryable={resumeRetryable} />
      ) : (
        <>
        <form className="ui-composer__box" onSubmit={submit}>
          <div className="ui-composer__row">
          <label className="ui-visually-hidden" htmlFor="session-message">Message to {ownerName}'s session</label>
          <textarea
            ref={inputRef}
            id="session-message"
            className="ui-composer__input"
            rows={2}
            autoFocus={autoFocus}
            maxLength={MAX_INPUT_CHARS}
            placeholder={sleeping ? "Send a message to wake this session." : `Message ${ownerName}'s session`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Tab" && event.shiftKey && onCycleMode && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onCycleMode();
              } else if (event.key === "Escape" && !text && onEmptyEscape) onEmptyEscape();
              else submitOnEnter(() => void submit())(event);
            }}
          />
          <div className="ui-composer__footer">
            {agentControl}
            <button type="submit" className="ui-btn ui-btn--primary" disabled={!text.trim()}>
              Send
            </button>
          </div>
          </div>
        </form>
        {modeControl && <div className="ui-composer__modes">{modeControl}</div>}
        </>
      )}
      {error && <p className="ui-error" role="alert">{error}</p>}
    </div>
  );
}
