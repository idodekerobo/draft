"use client";

import { useEffect, useRef, useState } from "react";
import { formatMessageTime } from "./share-links";

const COPIED_MS = 1_500;

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const CopyIcon = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
  </Icon>
);
const LinkIcon = () => (
  <Icon>
    <path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5l-.75.75" />
    <path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0L3.5 9a2.5 2.5 0 0 0 3.5 3.5l.75-.75" />
  </Icon>
);
const CheckIcon = () => (
  <Icon>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);

function CopyAction({ label, text, children }: { label: string; text: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  function copy() {
    // If the clipboard is blocked, the button stays as it was.
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    }).catch(() => {});
  }
  return (
    <button type="button" className="ui-stream__action" onClick={copy} aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label}>
      {copied ? <CheckIcon /> : children}
    </button>
  );
}

/** Shows under a message on hover or focus: copy its text, copy a link to it, and when it was sent. */
export function MessageActions({ text, at, linkUrl }: { text: string; at: string; linkUrl?: string }) {
  const time = formatMessageTime(at);
  return (
    <div className="ui-stream__actions">
      <CopyAction label="Copy message" text={text}><CopyIcon /></CopyAction>
      {linkUrl && <CopyAction label="Copy link to message" text={linkUrl}><LinkIcon /></CopyAction>}
      {time && <time className="ui-stream__time" dateTime={at}>{time}</time>}
    </div>
  );
}
