"use client";

import { DEFAULT_HARNESS_ID, HARNESSES, getHarness, modelLabel, type HarnessId } from "draft-core/harnesses";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { SectionedPicker } from "../controls/SectionedPicker";
import { clearDraft, NEW_SESSION_DRAFT_KEY, useDraft } from "./drafts";
import { FolderIcon, submitOnEnter, useAutoGrow } from "./message-box";
import { ColumnToggleButton } from "./SessionsLayout";
import { usePopover } from "./usePopover";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export type StartResult = { ok: true } | { ok: false; error: string };

export interface StartRequest {
  harness: HarnessId;
  folderPath: string;
  text: string;
  /** Alias the harness CLI takes as its model; null for the harness default. */
  model: string | null;
}

/** Why a harness cannot be started on this computer yet, or may not work well. */
export type HarnessProblem = "missing" | "signed_out" | "untested_version";

const PROBLEM_HINTS: Record<HarnessProblem, string> = { missing: "Set up", signed_out: "Set up", untested_version: "Untested version" };

/** Blocks Start. An untested version only warns. */
const blocks = (problem: HarnessProblem | undefined) => problem === "missing" || problem === "signed_out";

function problemLine(label: string, problem: HarnessProblem | undefined): string | null {
  if (problem === "missing") return `${label} is not installed on this computer.`;
  if (problem === "signed_out") return `${label} is not signed in. Run it in a terminal and sign in.`;
  if (problem === "untested_version") return `This version of ${label} is newer or older than the one Draft was tested with. Some things may not work.`;
  return null;
}

/** Empty state of the Sessions area: pick a folder, type a first message, start. */
export function SessionStartScreen({
  recentFolders,
  onBrowse,
  onStart,
  availability = {},
  renderSetup,
}: {
  /** What is wrong with a harness on this computer, by harness id. A harness with no entry is ready. */
  availability?: Partial<Record<string, HarnessProblem>>;
  /** Help to make a harness ready, shown in place of the problem line while it blocks Start. Null for a harness with none. */
  renderSetup?: (harness: HarnessId) => ReactNode;
  recentFolders: string[];
  onBrowse: () => Promise<string | null>;
  onStart: (request: StartRequest) => Promise<StartResult>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useDraft(NEW_SESSION_DRAFT_KEY);
  const [harness, setHarness] = useState<HarnessId>(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, text);
  const folder = chosen ?? recentFolders[0] ?? null;
  const setup = blocks(availability[harness]) ? renderSetup?.(harness) : null;
  const line = problemLine(getHarness(harness)?.label ?? harness, availability[harness]);

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
      const result = await onStart({ harness, folderPath: folder, text: message, model });
      if (result.ok) clearDraft(NEW_SESSION_DRAFT_KEY);
      else setError(result.error);
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
              ref={inputRef}
              id="start-message"
              className="ui-composer__input ph-no-capture"
              rows={2}
              autoFocus
              placeholder="Describe a task to start a new session…"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={submitOnEnter(() => void submit())}
            />
            <div className="ui-composer__footer">
              <SectionedPicker
                label="Agent and model"
                sections={[
                  { id: "harness", title: "Harnesses", value: harness, keepOpen: true, onChange: (value) => { setHarness(value as HarnessId); setModel(null); }, options: HARNESSES.map((option) => ({ value: option.id, label: option.label, hint: availability[option.id] ? PROBLEM_HINTS[availability[option.id]!] : undefined })) },
                  { id: "model", title: "Models", value: model ?? "", onChange: (value) => setModel(value || null), options: (getHarness(harness)?.models ?? []).map((option) => ({ value: option.alias ?? "", label: option.label })) },
                ]}
              >
                {getHarness(harness)?.label} · {modelLabel(harness, model)}
              </SectionedPicker>
              <button type="submit" className="ui-btn ui-btn--primary" disabled={starting || !folder || !text.trim() || blocks(availability[harness])}>
                {starting ? "Starting…" : "Start"}
              </button>
            </div>
          </div>
        </form>
        {!folder && <p className="ui-muted">Choose a folder to start in.</p>}
        {setup ?? (line && <p className={blocks(availability[harness]) ? "ui-error" : "ui-muted"} role="status">{line}</p>)}
        {error && <p className="ui-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
