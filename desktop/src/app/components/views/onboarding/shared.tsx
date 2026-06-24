// shared.tsx — shared UI components for onboarding steps

import { useEffect, useState, type ReactNode } from "react";
import type { ContextFileEntry, HeadlessSetupPhase } from "../../../../rpc/schema";
import { events, rpc } from "../../../rpc";
import { formatTokens } from "../../shared/skills";

// ── CopyableCmd ───────────────────────────────────────────────────────────────

export function CopyableCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  }
  return (
    <button className="onboarding__cmd" onClick={handleCopy} title="Copy to clipboard">
      <span className="onboarding__cmd-text">{cmd}</span>
      <span className="onboarding__cmd-copy">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

// ── ScanSkillRow ──────────────────────────────────────────────────────────────

export function ScanSkillRow({ name, description, descriptionTokenCount, tokenCount, selected, focused, onClick }: {
  name: string;
  description: string;
  descriptionTokenCount: number;
  tokenCount: number;
  selected: boolean;
  focused?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`onboarding__skill-row${focused ? " onboarding__skill-row--focused" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
    >
      <span className="onboarding__skill-check" aria-hidden="true">{selected ? "✓" : ""}</span>
      <span className="onboarding__skill-info">
        <span className="onboarding__skill-name">{name}</span>
        {description && <span className="onboarding__skill-desc">{description}</span>}
      </span>
      <span className="onboarding__skill-tokens" data-tooltip={`Description: ~${formatTokens(descriptionTokenCount)} tokens (always loaded)\nFull skill: ~${formatTokens(tokenCount)} tokens (loaded on invocation)`}>
        ~{formatTokens(tokenCount)}
      </span>
    </button>
  );
}

// ── CollapsibleSection ────────────────────────────────────────────────────────

export function CollapsibleSection({ label, count, expanded, onToggle, onSelectAll, onDeselectAll, allSelected, noneSelected, stickyIndex, children }: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  allSelected?: boolean;
  noneSelected?: boolean;
  stickyIndex?: number;
  children?: ReactNode;
}) {
  const top = (stickyIndex ?? 0) * 36;
  return (
    <>
      <div className="onboarding__collapsible-header" role="group" aria-label={label} style={{ top }}>
        <button className="onboarding__collapsible-toggle" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? "▼" : "▶"} <span>{label.toUpperCase()} ({count})</span>
        </button>
        {count > 0 && onSelectAll && onDeselectAll && (
          <span className="onboarding__collapsible-actions">
            <button onClick={onSelectAll} disabled={allSelected}>Select all</button>
            <button onClick={onDeselectAll} disabled={noneSelected}>Deselect all</button>
          </span>
        )}
      </div>
      {expanded && children}
    </>
  );
}

// ── IntegrationSetupCard ──────────────────────────────────────────────────────

export function IntegrationSetupCard({ title, description, hint, connected, expanded, onToggle, children, action }: {
  title: string;
  description: string;
  hint: string;
  connected: boolean;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
  action?: string;
}) {
  return (
    <section className="onboarding__integration-card" aria-expanded={expanded}>
      <button className="onboarding__integration-header" onClick={onToggle} aria-expanded={expanded} disabled={connected}>
        <span className="onboarding__integration-title"><span>{title}</span><small>{description}</small></span>
        <span className="onboarding__integration-status">
          {connected
            ? <><span className="onboarding__status-dot onboarding__status-dot--green" />
                <span className="onboarding__integration-badge onboarding__integration-badge--connected">Connected</span></>
            : <><small>{hint}</small>{action ?? (expanded ? "▲" : "▼")}</>}
        </span>
      </button>
      {!connected && expanded && <div className="onboarding__integration-content">{children}</div>}
    </section>
  );
}

// ── HeadlessProgress ──────────────────────────────────────────────────────────

export function HeadlessProgress({ label }: { label: string }) {
  return (
    <div className="onboarding__headless-progress" aria-live="polite">
      <span className="onboarding__spinner" />
      <span>{label}</span>
    </div>
  );
}

// ── HeadlessSetupPanel ───────────────────────────────────────────────────────

type Runner = "claude" | "codex";

interface HeadlessSetupPanelProps {
  onComplete: () => void;
  onSkip?: () => void;
  skipLabel?: string;
  completeLabel?: string;
}

export function HeadlessSetupPanel({ onComplete, onSkip, skipLabel = "Skip for now", completeLabel = "Looks good" }: HeadlessSetupPanelProps) {
  const [phase, setPhase] = useState<HeadlessSetupPhase | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [files, setFiles] = useState<ContextFileEntry[]>([]);
  const [lastMode, setLastMode] = useState<"import" | "github">("import");
  const [showDetail, setShowDetail] = useState(false);
  const [expandedOption, setExpandedOption] = useState<"folder" | "github" | null>(null);

  const [availableRunners, setAvailableRunners] = useState<Runner[]>([]);
  const [selectedRunner, setSelectedRunner] = useState<Runner>("claude");
  const [runnersLoaded, setRunnersLoaded] = useState(false);

  useEffect(() => {
    void rpc.request.getAvailableRunners().then((result) => {
      const installed = result.runners.filter((r) => r.installed).map((r) => r.name);
      setAvailableRunners(installed);
      if (installed.length > 0 && !installed.includes(selectedRunner)) {
        setSelectedRunner(installed[0]);
      }
      setRunnersLoaded(true);
    }).catch(() => setRunnersLoaded(true));
  }, []);

  useEffect(() => events.on("headlessProgress", (progress) => {
    setPhase(progress.phase);
    setLabel(progress.label);
    if (progress.phase === "error") {
      setError(progress.label);
      setErrorDetail(progress.error ?? null);
    }
    if (progress.phase === "complete") void rpc.request.getContextFiles().then(setFiles).catch(() => {});
  }), []);

  async function selectFolder() {
    const result = await rpc.request.selectSetupFolder();
    if (result.folderPath) setFolderPath(result.folderPath);
  }

  async function start(mode: "import" | "github") {
    setLastMode(mode);
    setError(null);
    setErrorDetail(null);
    setShowDetail(false);
    setFiles([]);
    const result = await rpc.request.runHeadlessSetup({
      mode,
      runner: selectedRunner,
      ...(mode === "import" ? { folderPath: folderPath ?? undefined } : {}),
      ...(mode === "github" ? { githubUrl: githubUrl.trim() || undefined } : {}),
    });
    if (!result.ok) {
      setPhase("error");
      setError(result.error ?? "Could not start context setup.");
    }
  }

  const running = phase === "starting" || phase === "running" || phase === "writing";
  const noRunnersInstalled = runnersLoaded && availableRunners.length === 0;
  const canStart = expandedOption === "folder" ? !!folderPath : expandedOption === "github" ? !!githubUrl.trim() : false;

  return (
    <>
      {noRunnersInstalled && (
        <div className="onboarding__manual-fallback">
          <p className="onboarding__error">No CLI runner found. Install Claude Code or Codex, then open your terminal and run:</p>
          <CopyableCmd cmd="/draft-setup" />
        </div>
      )}

      {!phase && !noRunnersInstalled && <>
        {runnersLoaded && availableRunners.length > 1 && (
          <div className="onboarding__runner-picker">
            <span className="onboarding__runner-label">Run with</span>
            <div className="onboarding__mode-picker">
              {availableRunners.map((r) => (
                <button key={r} className={selectedRunner === r ? "onboarding__mode--selected" : ""} onClick={() => setSelectedRunner(r)}>
                  {r === "claude" ? "Claude Code" : "Codex"}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="onboarding__setup-options">
          <button
            className={`onboarding__setup-option${expandedOption === "folder" ? " onboarding__setup-option--active" : ""}`}
            onClick={() => { if (expandedOption === "folder") { setExpandedOption(null); setFolderPath(null); } else { setExpandedOption("folder"); } }}
          >
            <strong>Import a local folder</strong>
          </button>
          <div className={`onboarding__setup-expand-wrapper${expandedOption === "folder" ? " onboarding__setup-expand-wrapper--open" : ""}`}>
            <div className="onboarding__setup-expanded">
              <button className="onboarding__setup-folder-btn" onClick={() => void selectFolder()}>
                {folderPath ?? "Choose a folder…"}
              </button>
            </div>
          </div>

          <button
            className={`onboarding__setup-option${expandedOption === "github" ? " onboarding__setup-option--active" : ""}`}
            onClick={() => { if (expandedOption === "github") { setExpandedOption(null); setGithubUrl(""); } else { setExpandedOption("github"); } }}
          >
            <strong>Import from GitHub</strong>
          </button>
          <div className={`onboarding__setup-expand-wrapper${expandedOption === "github" ? " onboarding__setup-expand-wrapper--open" : ""}`}>
            <div className="onboarding__setup-expanded">
              <input
                className="onboarding__integration-input"
                type="url"
                value={githubUrl}
                onChange={(event) => setGithubUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                aria-label="GitHub repository URL"
                autoFocus
              />
            </div>
          </div>

          {canStart && (
            <button className="empty-state__cta onboarding__cta" onClick={() => void start(expandedOption === "folder" ? "import" : "github")}>
              Set up context
            </button>
          )}
        </div>
      </>}

      {running && <HeadlessProgress label={label} />}

      {error && !running && (
        <div className="onboarding__error-block">
          <p className="onboarding__error">{error}</p>
          {errorDetail && (
            <button className="onboarding__error-toggle" onClick={() => setShowDetail(!showDetail)}>
              {showDetail ? "Hide details" : "Show details"}
            </button>
          )}
          {showDetail && errorDetail && (
            <pre className="onboarding__error-detail">{errorDetail}</pre>
          )}
        </div>
      )}

      {phase === "complete" && <>
        <p className="onboarding__headless-success">{label}</p>
        {files.length > 0 && <p className="onboarding__hint">Created or updated: {files.slice(0, 4).map((file) => file.label).join(", ")}{files.length > 4 ? ", and more" : ""}.</p>}
        <div className="onboarding__actions" style={{ marginTop: 20 }}>
          <button className="onboarding__skip" onClick={() => rpc.send.openWorkspaceInFinder()}>Open in Finder</button>
          <button className="empty-state__cta onboarding__cta" onClick={onComplete}>{completeLabel}</button>
        </div>
      </>}

      {(error || !phase) && !noRunnersInstalled && <div className="onboarding__manual-fallback">
        {error && <button className="empty-state__cta onboarding__cta" onClick={() => void start(lastMode)}>Try again</button>}
        <p>Prefer to do this manually? Open {selectedRunner === "claude" ? "Claude Code" : "Codex"} and run:</p>
        <CopyableCmd cmd="/draft-setup" />
      </div>}
    </>
  );
}
