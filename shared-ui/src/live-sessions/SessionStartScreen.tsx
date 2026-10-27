"use client";

import { useState, type FormEvent } from "react";
import { FolderIcon, submitOnEnter } from "./message-box";
import { ColumnToggleButton } from "./SessionsLayout";
import { usePopover } from "./usePopover";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export type StartResult = { ok: true } | { ok: false; error: string };

/** Empty state of the Sessions area: pick a folder, type a first message, start. */
export function SessionStartScreen({
  recentFolders,
  onBrowse,
  onStart,
}: {
  recentFolders: string[];
  onBrowse: () => Promise<string | null>;
  onStart: (folderPath: string, text: string) => Promise<StartResult>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const folder = chosen ?? recentFolders[0] ?? null;

  async function browse() {
    setOpen(false);
    const picked = await onBrowse();
    if (picked) setChosen(picked);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = text.trim();
    if (!folder || !message || starting) return;
    setStarting(true);
    setError(null);
    try {
      const result = await onStart(folder, message);
      if (!result.ok) setError(result.error);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="ui-session ui-start">
      <header className="ui-session__header">
        <nav className="ui-session__crumbs" aria-label="Breadcrumb">
          <ColumnToggleButton where="main" />
          <h1 className="ui-session__title">New session</h1>
        </nav>
      </header>
      <div className="ui-start__body">
        <p className="ui-start__heading">What should we work on?</p>
        <form className="ui-composer__box ui-start__box" onSubmit={submit}>
          <div className="ui-composer__folder ui-start__folder" ref={rootRef}>
            <button ref={triggerRef} type="button" className="ui-start__folder-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <FolderIcon />
              <span>{folder ? folderName(folder) : "Choose a folder"}</span>
              <span aria-hidden="true">▾</span>
            </button>
            {open && (
              <ul className="ui-session__menu-list ui-start__menu" role="menu">
                {recentFolders.map((path) => (
                  <li key={path} role="none">
                    <button type="button" role="menuitem" className="ui-session__menu-item" title={path} onClick={() => { setChosen(path); setOpen(false); }}>
                      {folderName(path)}
                      <span className="ui-muted ui-start__path">{path}</span>
                    </button>
                  </li>
                ))}
                <li role="none">
                  <button type="button" role="menuitem" className="ui-session__menu-item" onClick={() => void browse()}>Browse…</button>
                </li>
              </ul>
            )}
          </div>
          <div className="ui-composer__row">
            <label className="ui-visually-hidden" htmlFor="start-message">First message</label>
            <textarea
              id="start-message"
              className="ui-composer__input"
              rows={3}
              autoFocus
              placeholder="Describe a task to start a new session…"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={submitOnEnter(() => void submit())}
            />
            <button type="submit" className="ui-btn ui-btn--primary" disabled={starting || !folder || !text.trim()}>
              {starting ? "Starting…" : "Start"}
            </button>
          </div>
        </form>
        {!folder && <p className="ui-muted">Choose a folder to start in.</p>}
        {error && <p className="ui-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
