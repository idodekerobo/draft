"use client";

import { DEFAULT_HARNESS_ID, HARNESSES, getHarness, type HarnessId } from "draft-core/harnesses";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { SectionedPicker } from "../controls/SectionedPicker";
import { clearDraft, NEW_SESSION_DRAFT_KEY, useDraft } from "./drafts";
import { agentPickerSections, agentSummary } from "../controls/agent-picker";
import { useAgentDefaults, type AgentDefaultsLoader } from "./useAgentDefaults";
import { FolderIcon, submitOnEnter, useAutoGrow } from "./message-box";
import { ColumnToggleButton } from "./SessionsLayout";
import { usePopover } from "./usePopover";
import { Toggle } from "../settings/SettingsRow";
import { branchProblem, cloudRepoFromRemote, cloudStartFailure, repoProblem, type CloudStartField } from "./cloud-start";

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** `detail` is a sentence for the person, when the code alone does not say enough (a folder over the size cap). */
export type StartResult = { ok: true } | { ok: false; error: string; detail?: string };

interface StartFields {
  text: string;
  /** Alias the harness CLI takes as its model; null for the harness default. */
  model: string | null;
  /** A reasoning effort the model accepts; null for the harness default. */
  effort: string | null;
}

/** A session on this computer. `runtime` is left out, since a computer is the default. */
export interface LocalStartRequest extends StartFields {
  runtime?: "local";
  harness: HarnessId;
  folderPath: string;
}

/** A session in Draft cloud that starts from a GitHub repository. Only Claude Code runs there. */
export interface CloudStartRequest extends StartFields {
  runtime: "cloud";
  harness: "claude";
  source: "repo";
  /** The https address of the GitHub repository. */
  gitRemote: string;
  branch: string;
  network: "restricted" | "open";
}

/** A session in Draft cloud that starts from a copy of a folder. Only the `.env` files in `includeEnvFiles` are copied. */
export interface CloudSnapshotStartRequest extends StartFields {
  runtime: "cloud";
  harness: "claude";
  source: "snapshot";
  folderPath: string;
  /** Paths relative to the folder, as the checklist listed them. */
  includeEnvFiles: string[];
  network: "restricted" | "open";
}

export type StartRequest = LocalStartRequest | CloudStartRequest | CloudSnapshotStartRequest;

/** Why a harness cannot be started on this computer yet, or may not work well. */
export type HarnessProblem = "missing" | "signed_out" | "untested_version";

const PROBLEM_HINTS: Record<HarnessProblem, string> = { missing: "Set up", signed_out: "Set up", untested_version: "Untested version" };

/** Blocks Start. An untested version only warns. */
const blocks = (problem: HarnessProblem | undefined) => problem === "missing" || problem === "signed_out";

function problemLine(label: string, problem: HarnessProblem | undefined, devOnly: boolean): string | null {
  if (problem === "missing") return `${label} is not installed on this computer.`;
  if (problem === "signed_out") return `${label} is not signed in. Run it in a terminal and sign in.`;
  if (problem === "untested_version" && devOnly) return `[DEV ONLY] This version of ${label} is newer or older than the one Draft was tested with. Some things may not work.`;
  return null;
}

const RUNTIMES = [
  { value: "local", label: "This computer" },
  { value: "cloud", label: "Draft cloud" },
] as const;

type Runtime = (typeof RUNTIMES)[number]["value"];

const SOURCES = [
  { value: "repo", label: "GitHub repository" },
  { value: "snapshot", label: "This folder (snapshot)" },
] as const;

type Source = (typeof SOURCES)[number]["value"];

/** A start that failed, and the part of the screen it belongs to. */
type Failure = { field: CloudStartField; message: string };

/**
 * A row of radio buttons. Arrow keys move the choice and the focus. Used for where a session runs and where its files come from.
 */
function Segmented<T extends string>({
  labelId,
  options,
  value,
  onChoose,
}: {
  labelId: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChoose: (next: T) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const index = (options.findIndex((option) => option.value === value) + step + options.length) % options.length;
    onChoose(options[index]!.value);
    buttons.current[index]?.focus();
  }

  return (
    <div className="ui-segmented" role="radiogroup" aria-labelledby={labelId}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => { buttons.current[index] = node; }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          className={`ui-segmented__option${value === option.value ? " ui-segmented__option--selected" : ""}`}
          onClick={() => onChoose(option.value)}
          onKeyDown={onKey}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Empty state of the Sessions area: pick where it runs and a folder or repository, type a first message, start.
 * `cloud` turns on Draft cloud. Its `folderRemote` reads a folder's git remote to fill in the repository, and its
 * `envFiles` lists the `.env` files a folder snapshot could include.
 */
export function SessionStartScreen({
  recentFolders,
  onBrowse,
  onStart,
  availability = {},
  devOnly = false,
  agentDefaults,
  renderSetup,
  cloud,
}: {
  /** What is wrong with a harness on this computer, by harness id. A harness with no entry is ready. */
  availability?: Partial<Record<string, HarnessProblem>>;
  /** Show untested-version notices in development builds only. */
  devOnly?: boolean;
  /** Says what "Default" means for a harness on this computer. Only the desktop app can. */
  agentDefaults?: AgentDefaultsLoader;
  /** Help to make a harness ready, shown in place of the problem line while it blocks Start. Null for a harness with none. */
  renderSetup?: (harness: HarnessId) => ReactNode;
  /** Offers Draft cloud. Keep both functions stable: each runs again whenever its identity changes. */
  cloud?: {
    folderRemote: (folderPath: string) => Promise<string | null>;
    /** The `.env*` files in a folder, relative to it. Rejects when the folder cannot be read. */
    envFiles: (folderPath: string) => Promise<string[]>;
  };
  recentFolders: string[];
  onBrowse: () => Promise<string | null>;
  onStart: (request: StartRequest) => Promise<StartResult>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [text, setText] = useDraft(NEW_SESSION_DRAFT_KEY);
  const [harness, setHarness] = useState<HarnessId>(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<Runtime>("local");
  const [source, setSource] = useState<Source>("repo");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [openNetwork, setOpenNetwork] = useState(false);
  const [envFiles, setEnvFiles] = useState<string[] | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [includeEnv, setIncludeEnv] = useState<string[]>([]);
  const repoEdited = useRef(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ids = { where: useId(), source: useId(), repo: useId(), branch: useId(), repoError: useId(), branchError: useId(), network: useId() };
  useAutoGrow(inputRef, text);

  const folder = chosen ?? recentFolders[0] ?? null;
  const cloudOn = cloud !== undefined && runtime === "cloud";
  const snapshotOn = cloudOn && source === "snapshot";
  // Cloud sessions run Claude Code wherever the computer's own setup is, so the local harness picks no longer apply.
  const activeHarness: HarnessId = cloudOn ? "claude" : harness;
  const localProblem = cloudOn ? undefined : availability[harness];
  const setup = blocks(localProblem) ? renderSetup?.(harness) : null;
  const line = problemLine(getHarness(harness)?.label ?? harness, localProblem, devOnly);
  const defaults = useAgentDefaults(cloudOn ? undefined : agentDefaults, activeHarness);
  const folderRemote = cloud?.folderRemote;
  const envFilesOf = cloud?.envFiles;

  const repoValue = cloudRepoFromRemote(repo);
  const repoError = repo.trim() ? repoProblem(repoValue) : null;
  const branchError = branchProblem(branch);
  const cloudReady = !repoProblem(repoValue) && !branchProblem(branch) && repoValue !== "" && branch.trim() !== "";
  // The checklist must have loaded, or failed, before a snapshot can start. A failed listing includes no .env files.
  const snapshotReady = folder !== null && (envFiles !== null || envError !== null);
  const cloudStartable = snapshotOn ? snapshotReady : cloudReady;

  // The repository follows the folder's git remote until the person types their own.
  useEffect(() => {
    if (!cloudOn || !folder || !folderRemote) return;
    let current = true;
    void folderRemote(folder)
      .then((remote) => {
        if (current && !repoEdited.current) setRepo(remote ? cloudRepoFromRemote(remote) : "");
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [cloudOn, folder, folderRemote]);

  // The .env checklist follows the folder. A new folder starts with nothing ticked.
  useEffect(() => {
    setEnvFiles(null);
    setEnvError(null);
    setIncludeEnv([]);
    if (!snapshotOn || !folder || !envFilesOf) return;
    let current = true;
    envFilesOf(folder)
      .then((files) => {
        if (current) setEnvFiles(files);
      })
      .catch((error: unknown) => {
        console.error("[sessions] could not list the folder's .env files", error);
        if (current) setEnvError("Draft could not read this folder's .env files, so none will be included.");
      });
    return () => {
      current = false;
    };
  }, [snapshotOn, folder, envFilesOf]);

  function chooseRuntime(next: Runtime) {
    setFailure(null);
    setRuntime(next);
    if (next === "cloud" && harness !== "claude") {
      setHarness("claude");
      setModel(null);
      setEffort(null);
    }
  }

  function chooseSource(next: Source) {
    setFailure(null);
    setSource(next);
  }

  function toggleEnvFile(file: string, ticked: boolean) {
    setFailure(null);
    setIncludeEnv((current) => (ticked ? [...current, file] : current.filter((entry) => entry !== file)));
  }

  async function browse() {
    setOpen(false);
    const picked = await onBrowse();
    if (picked) setChosen(picked);
  }

  /** The failure the person sees for a start that did not happen. A server code maps to the part of the form it is about. */
  function failureOf(result: { error: string; detail?: string }): Failure {
    if (!cloudOn) return { field: "general", message: result.error };
    if (result.detail) return { field: "general", message: result.detail };
    return cloudStartFailure(result.error, snapshotOn ? "snapshot" : "repo");
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = text.trim();
    if (!message || starting) return;
    if (cloudOn ? !cloudStartable : !folder) return;
    const fields = { text: message, model, effort };
    const request: StartRequest = cloudOn
      ? snapshotOn
        ? {
            ...fields,
            runtime: "cloud",
            harness: "claude",
            source: "snapshot",
            folderPath: folder!,
            includeEnvFiles: (envFiles ?? []).filter((file) => includeEnv.includes(file)),
            network: openNetwork ? "open" : "restricted",
          }
        : { ...fields, runtime: "cloud", harness: "claude", source: "repo", gitRemote: repoValue, branch: branch.trim(), network: openNetwork ? "open" : "restricted" }
      : { ...fields, harness, folderPath: folder! };
    setStarting(true);
    setFailure(null);
    try {
      const result = await onStart(request);
      if (result.ok) clearDraft(NEW_SESSION_DRAFT_KEY);
      else setFailure(failureOf(result));
    } finally {
      setStarting(false);
    }
  }

  const repoShown = repoError ?? (failure?.field === "repo" ? failure.message : null);
  const branchShown = branchError ?? (failure?.field === "branch" ? failure.message : null);

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
        {cloud && (
          <div className="ui-start__where">
            <span id={ids.where} className="ui-muted">Where it runs</span>
            <Segmented labelId={ids.where} options={RUNTIMES} value={runtime} onChoose={chooseRuntime} />
          </div>
        )}
        {cloudOn && (
          <div className="ui-start__where">
            <span id={ids.source} className="ui-muted">Source</span>
            <Segmented labelId={ids.source} options={SOURCES} value={source} onChoose={chooseSource} />
          </div>
        )}
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
          {cloudOn && !snapshotOn && (
            <div className="ui-start__repo">
              <div className="ui-start__field ui-start__field--repo">
                <label htmlFor={ids.repo} className="ui-muted">Repository</label>
                <input
                  id={ids.repo}
                  className="ui-input ph-no-capture"
                  value={repo}
                  placeholder="https://github.com/owner/repo"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={repoShown ? true : undefined}
                  aria-describedby={repoShown ? ids.repoError : undefined}
                  onChange={(event) => { repoEdited.current = true; setFailure(null); setRepo(event.target.value); }}
                />
                {repoShown && <p id={ids.repoError} className="ui-error ui-start__field-error">{repoShown}</p>}
              </div>
              <div className="ui-start__field ui-start__field--branch">
                <label htmlFor={ids.branch} className="ui-muted">Branch</label>
                <input
                  id={ids.branch}
                  className="ui-input ph-no-capture"
                  value={branch}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={branchShown ? true : undefined}
                  aria-describedby={branchShown ? ids.branchError : undefined}
                  onChange={(event) => { setFailure(null); setBranch(event.target.value); }}
                />
                {branchShown && <p id={ids.branchError} className="ui-error ui-start__field-error">{branchShown}</p>}
              </div>
            </div>
          )}
          {snapshotOn && (
            <div className="ui-start__snapshot">
              <p className="ui-muted">Copies this folder to Draft cloud. The .git folder and node_modules are left out.</p>
              <fieldset className="ui-start__env">
                <legend className="ui-muted">.env files</legend>
                {envFiles && envFiles.length > 0 && <p className="ui-start__warning" role="note">Anyone in this session can ask the agent to read these.</p>}
                {envError && <p className="ui-error" role="alert">{envError}</p>}
                {envFiles === null && !envError && <p className="ui-muted" role="status">Looking for .env files…</p>}
                {envFiles?.length === 0 && <p className="ui-muted">No .env files in this folder.</p>}
                {envFiles?.map((file) => (
                  <label key={file} className="ui-start__env-file">
                    <input type="checkbox" checked={includeEnv.includes(file)} onChange={(event) => toggleEnvFile(file, event.target.checked)} />
                    <code>{file}</code>
                  </label>
                ))}
              </fieldset>
            </div>
          )}
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
                align="start"
                sections={agentPickerSections({
                  value: { harness: activeHarness, model, effort },
                  defaults,
                  onChange: (next) => { setHarness(next.harness); setModel(next.model); setEffort(next.effort); },
                  harnesses: HARNESSES.map((option) => ({ value: option.id, label: option.label, hint: availability[option.id] ? PROBLEM_HINTS[availability[option.id]!] : undefined })),
                  lockHarness: cloudOn,
                })}
              >
                {agentSummary(activeHarness, model, effort, defaults)}
              </SectionedPicker>
              <button
                type="submit"
                className="ui-btn ui-btn--primary"
                disabled={starting || !text.trim() || (cloudOn ? !cloudStartable : !folder || blocks(localProblem))}
              >
                {starting ? "Starting…" : "Start"}
              </button>
            </div>
          </div>
        </form>
        {cloudOn && (
          <div className="ui-start__cloud">
            <p className="ui-muted">Cloud sessions run Claude Code.</p>
            <div className="ui-start__network">
              <Toggle
                checked={openNetwork}
                labelledBy={ids.network}
                onChange={(next) => { setFailure(null); setOpenNetwork(next); }}
              />
              <span id={ids.network} className="ui-start__network-label">Open network</span>
              <span className="ui-muted">Restricted limits where the agent can connect.</span>
            </div>
            {openNetwork && <p className="ui-start__warning" role="note">Anyone in this session can make the agent send data anywhere.</p>}
            {failure?.field === "network" && <p className="ui-error" role="alert">{failure.message}</p>}
          </div>
        )}
        {!cloudOn && !folder && <p className="ui-muted">Choose a folder to start in.</p>}
        {snapshotOn && !folder && <p className="ui-muted">Choose a folder to copy.</p>}
        {!cloudOn && (setup ?? (line && <p className={blocks(localProblem) ? "ui-error" : "ui-muted"} role="status">{line}</p>))}
        {failure && failure.field !== "repo" && failure.field !== "branch" && failure.field !== "network" && <p className="ui-error" role="alert">{failure.message}</p>}
      </div>
    </div>
  );
}
