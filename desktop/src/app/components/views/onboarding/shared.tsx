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
            <button
              onClick={allSelected ? onDeselectAll : onSelectAll}
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </span>
        )}
      </div>
      {expanded && children}
    </>
  );
}

// ── IntegrationSetupCard ──────────────────────────────────────────────────────

export function IntegrationSetupCard({ title, description, hint, connected, expanded, onToggle, children, action, keepContentWhenConnected }: {
  title: string;
  description: string;
  hint: string;
  connected: boolean;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
  action?: string;
  /** Credential-less integrations (e.g. Coding Sessions) stay revisitable post-connect, unlike Slack/Fireflies/Linear whose header locks once connected. */
  keepContentWhenConnected?: boolean;
}) {
  return (
    <section className="onboarding__integration-card" aria-expanded={expanded}>
      <button className="onboarding__integration-header" onClick={onToggle} aria-expanded={expanded} disabled={connected && !keepContentWhenConnected}>
        <span className="onboarding__integration-title"><span>{title}</span><small>{description}</small></span>
        <span className="onboarding__integration-status">
          {connected
            ? <><span className="onboarding__status-dot onboarding__status-dot--green" />
                <span className="onboarding__integration-badge onboarding__integration-badge--connected">Connected</span></>
            : <><small>{hint}</small>{action ?? (expanded ? "▲" : "▼")}</>}
        </span>
      </button>
      {(keepContentWhenConnected ? expanded : !connected && expanded) && <div className="onboarding__integration-content">{children}</div>}
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

// ── DimensionPicker ──────────────────────────────────────────────────────────
// Lets the user keep the standard four context dimensions or customize the set
// (drop defaults, add their own) before headless setup runs. Mirrors the
// scaffold shape used by `draft dimension add` / the draft-add-dimension skill.

export const DEFAULT_SETUP_DIMENSIONS = ["company", "product", "team", "priorities"];

// Mirrors core/src/agents/prompts/setup.ts's DIMENSION_GUIDANCE — kept as a
// separate copy since the desktop app doesn't depend on core/.
export const DEFAULT_DIMENSION_DESCRIPTIONS: Record<string, string> = {
  company: "name, what they build, business model, stage, target market, key constraints",
  product: "product name, problem it solves, target user, key features, current state, open hypotheses",
  team: "who's on the team, roles, structure, how decisions get made",
  priorities: "active TODOs, current sprint goal, blockers, what success looks like",
};

export interface DimensionHint {
  dimensionName: string;
  dimensionDescription: string;
}

export function toDimensionHints(names: string[], descriptions?: Record<string, string>): DimensionHint[] {
  return names.map((name) => ({
    dimensionName: name,
    dimensionDescription: descriptions?.[name]?.trim() || DEFAULT_DIMENSION_DESCRIPTIONS[name] || `User-defined dimension: ${name}`,
  }));
}

/** Seeds a descriptions map for the given dimension names, pre-filled with the
 *  default guidance where one exists (empty string for custom dims). */
export function defaultDimensionDescriptions(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, DEFAULT_DIMENSION_DESCRIPTIONS[name] ?? ""]));
}

export function DimensionPicker({ dimensions, onChange, descriptions, onDescriptionsChange }: {
  dimensions: string[];
  onChange: (next: string[]) => void;
  descriptions: Record<string, string>;
  onDescriptionsChange: (next: Record<string, string>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  function toggleDefault(name: string) {
    onChange(dimensions.includes(name) ? dimensions.filter((d) => d !== name) : [...dimensions, name]);
  }

  function updateDescription(name: string, value: string) {
    onDescriptionsChange({ ...descriptions, [name]: value });
  }

  function addCustom() {
    const slug = newName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug || dimensions.includes(slug)) return;
    onChange([...dimensions, slug]);
    if (newDescription.trim()) onDescriptionsChange({ ...descriptions, [slug]: newDescription.trim() });
    setNewName("");
    setNewDescription("");
  }

  const customDims = dimensions.filter((d) => !DEFAULT_SETUP_DIMENSIONS.includes(d));

  return (
    <div className="onboarding__dim-picker">
      <button className="onboarding__dim-picker-toggle" onClick={() => setExpanded((prev) => !prev)}>
        {expanded ? "▼" : "▶"} Customize context dimensions ({dimensions.length})
      </button>
      <p className="onboarding__dim-picker-subtitle">Draft tracks company, product, team, and priorities by default, keeping each up to date every session. Add your own (e.g. brand, architecture) and Draft will track those too.</p>
      {expanded && (
        <div className="onboarding__dim-picker-body">
          {DEFAULT_SETUP_DIMENSIONS.map((name) => (
            <div key={name} className="onboarding__dim-picker-item">
              <input
                id={`dim-${name}`}
                type="checkbox"
                checked={dimensions.includes(name)}
                onChange={() => toggleDefault(name)}
              />
              <div className="onboarding__dim-picker-content">
                <label htmlFor={`dim-${name}`} className="onboarding__dim-picker-name">{name}</label>
                {dimensions.includes(name) && (
                  <input
                    className="onboarding__dim-picker-desc-input"
                    value={descriptions[name] ?? ""}
                    placeholder="What should Draft look for?"
                    onChange={(e) => updateDescription(name, e.target.value)}
                  />
                )}
              </div>
            </div>
          ))}
          {customDims.map((name) => (
            <div key={name} className="onboarding__dim-picker-item">
              <input id={`dim-${name}`} type="checkbox" checked readOnly />
              <div className="onboarding__dim-picker-content">
                <div className="onboarding__dim-picker-name-row">
                  <label htmlFor={`dim-${name}`} className="onboarding__dim-picker-name">{name}</label>
                  <button className="onboarding__dim-picker-remove" onClick={() => onChange(dimensions.filter((d) => d !== name))} aria-label={`Remove ${name}`}>✕</button>
                </div>
                <input
                  className="onboarding__dim-picker-desc-input"
                  value={descriptions[name] ?? ""}
                  placeholder="What should Draft look for?"
                  onChange={(e) => updateDescription(name, e.target.value)}
                />
              </div>
            </div>
          ))}
          <div className="onboarding__dim-picker-add">
            <input
              className="onboarding__dim-picker-add-input"
              value={newName}
              placeholder="dimension name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addCustom(); }}
            />
            <input
              className="onboarding__dim-picker-add-input"
              value={newDescription}
              placeholder="short description (optional)"
              onChange={(e) => setNewDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addCustom(); }}
            />
            <button className="onboarding__dim-picker-add-btn" onClick={addCustom}>Add</button>
          </div>
        </div>
      )}
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
  const [dimensions, setDimensions] = useState<string[]>(DEFAULT_SETUP_DIMENSIONS);
  const [dimensionDescriptions, setDimensionDescriptions] = useState<Record<string, string>>(defaultDimensionDescriptions(DEFAULT_SETUP_DIMENSIONS));

  useEffect(() => {
    void rpc.request.getAvailableRunners().then((result) => {
      const installed = result.runners.filter((r) => r.installed).map((r) => r.name);
      setAvailableRunners(installed);
      const firstInstalled = installed[0];
      if (firstInstalled && !installed.includes(selectedRunner)) {
        setSelectedRunner(firstInstalled);
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
      dimensions,
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

        <DimensionPicker dimensions={dimensions} onChange={setDimensions} descriptions={dimensionDescriptions} onDescriptionsChange={setDimensionDescriptions} />

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
          <button className="onboarding__skip" onClick={() => rpc.send.openWorkspaceInFinder({})}>Open in Finder</button>
          <button className="empty-state__cta onboarding__cta" onClick={onComplete}>{completeLabel}</button>
        </div>
      </>}

      {(error || !phase) && !noRunnersInstalled && <div className="onboarding__manual-fallback">
        {error && <button className="empty-state__cta onboarding__cta" onClick={() => void start(lastMode)}>Try again</button>}
        <p>Prefer to have an agent interview you? Open {selectedRunner === "claude" ? "Claude Code" : "Codex"} and run:</p>
        <CopyableCmd cmd={selectedRunner === "codex" ? "@draft-setup" : "/draft-setup"} />
      </div>}
    </>
  );
}
