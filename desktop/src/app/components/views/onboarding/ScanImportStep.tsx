import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScannedSkillEntry, ScanDirError, ScannedMCPEntry } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { ScanSkillRow, CollapsibleSection } from "./shared";

interface ScanImportStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

type Agent = ScannedSkillEntry["agent"];

const AGENT_LABELS: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

// ── ErrorBoundary ─────────────────────────────────────────────────────────────

interface ErrorBoundaryState { error: Error | null }

class ScanErrorBoundary extends Component<{ children: ReactNode; onSkip: () => void; onRetry: () => void }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="onboarding__scan-error">
          <p className="onboarding__error">Could not scan skill directories. Check file permissions.</p>
          <div className="onboarding__actions" style={{ marginTop: 12 }}>
            <button className="onboarding__skip" onClick={() => { this.setState({ error: null }); this.props.onRetry(); }}>Retry</button>
            <button className="empty-state__cta onboarding__cta" onClick={this.props.onSkip}>Skip</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <div className="onboarding__skeleton" aria-busy="true" aria-label="Scanning skill directories">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="onboarding__skeleton-row">
          <span className="onboarding__skeleton-check" />
          <span className="onboarding__skeleton-name" />
          <span className="onboarding__skeleton-badge" />
          <span className="onboarding__skeleton-tokens" />
        </div>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ScanImportStep({ stepNum, totalSteps, onBack, onNext }: ScanImportStepProps) {
  const [skills, setSkills] = useState<ScannedSkillEntry[] | null>(null);
  const [mcpServers, setMcpServers] = useState<ScannedMCPEntry[]>([]);
  const [scanErrors, setScanErrors] = useState<ScanDirError[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<Agent, boolean>>({ "claude-code": true, codex: false });
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const retryKey = useRef(0);

  const keyFor = (skill: ScannedSkillEntry) => `${skill.agent}:${skill.dirPath}`;

  async function loadSkills() {
    setSkills(null);
    setError(null);
    setScanErrors([]);
    setMcpServers([]);
    try {
      const result = await rpc.request.scanSkills();
      if (result.skills.length === 0 && (!result.mcpServers || result.mcpServers.length === 0)) {
        onNext();
        return;
      }
      setSkills(result.skills);
      setMcpServers(result.mcpServers ?? []);
      setScanErrors(result.scanErrors ?? []);
      setSelected(new Set(result.skills.map(keyFor)));
    } catch {
      setError("Could not scan skill directories. Check file permissions.");
      setSkills([]);
    }
  }

  useEffect(() => { void loadSkills(); }, []);

  const grouped = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (Object.keys(AGENT_LABELS) as Agent[]).map((agent) => ({
      agent,
      skills: (skills ?? []).filter((skill) =>
        skill.agent === agent && (!normalizedQuery || skill.name.toLowerCase().includes(normalizedQuery)),
      ),
    }));
  }, [query, skills]);

  const flatVisibleSkills = useMemo(
    () => grouped.flatMap(({ agent, skills: s }) => expanded[agent] ? s : []),
    [grouped, expanded],
  );

  function toggle(skill: ScannedSkillEntry) {
    const key = keyFor(skill);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function selectSection(sectionSkills: ScannedSkillEntry[], shouldSelect: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const skill of sectionSkills) {
        const key = keyFor(skill);
        if (shouldSelect) next.add(key); else next.delete(key);
      }
      return next;
    });
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (flatVisibleSkills.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIndex((i) => Math.min(i + 1, flatVisibleSkills.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === " " && focusIndex >= 0 && focusIndex < flatVisibleSkills.length) {
      e.preventDefault();
      toggle(flatVisibleSkills[focusIndex]);
    }
  }, [flatVisibleSkills, focusIndex]);

  useEffect(() => {
    if (focusIndex < 0) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    rows?.[focusIndex]?.focus();
  }, [focusIndex]);

  async function importSelected() {
    const selectedSkills = (skills ?? []).filter((skill) => selected.has(keyFor(skill)));
    if (selectedSkills.length === 0) return onNext();
    setImporting(true);
    setError(null);
    try {
      const result = await rpc.request.importSkills({ skills: selectedSkills });
      if (!result.ok) {
        setError(result.error ?? "Some skills could not be imported. Try again or skip this step.");
        return;
      }
      onNext();
    } catch {
      setError("Could not import the selected skills. Try again or skip this step.");
    } finally {
      setImporting(false);
    }
  }

  const total = skills?.length ?? 0;
  const isLoading = skills === null && error === null;

  return (
    <div className="onboarding__body onboarding__body--wide">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Your existing skills</h1>
      <p className="onboarding__desc">
        {isLoading ? "Scanning your agent tools…" : `Draft found ${total} skill${total === 1 ? "" : "s"} across your agent tools. Review and select the ones to import.`}
      </p>

      <ScanErrorBoundary key={retryKey.current} onSkip={onNext} onRetry={() => { retryKey.current++; void loadSkills(); }}>
        {isLoading && <SkeletonRows />}
        {error && <p className="onboarding__error">{error}</p>}

        {scanErrors.length > 0 && (
          <div className="onboarding__scan-warnings">
            {scanErrors.map((err) => (
              <p key={err.dir} className="onboarding__warning">
                Could not read {AGENT_LABELS[err.agent]} skills directory. Some skills may be missing.
              </p>
            ))}
          </div>
        )}

        {!isLoading && skills && skills.length > 0 && (
          <>
            <input
              className="onboarding__search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter skills…"
              aria-label="Filter skills"
            />
            <p className="onboarding__sr-only" aria-live="polite">{grouped.reduce((count, group) => count + group.skills.length, 0)} skills match your filter.</p>
            <div className="onboarding__skill-list-header">
              <span>Skill</span>
              <span title="Approximate token count for the full SKILL.md file">Tokens</span>
            </div>
            <div className="onboarding__skill-list" role="listbox" aria-multiselectable="true" ref={listRef} onKeyDown={handleKeyDown} tabIndex={0}>
              {grouped.map(({ agent, skills: sectionSkills }, groupIndex) => {
                const allSelected = sectionSkills.length > 0 && sectionSkills.every((skill) => selected.has(keyFor(skill)));
                const noneSelected = sectionSkills.every((skill) => !selected.has(keyFor(skill)));
                return (
                  <CollapsibleSection
                    key={agent}
                    label={AGENT_LABELS[agent]}
                    count={sectionSkills.length}
                    stickyIndex={groupIndex}
                    expanded={expanded[agent]}
                    onToggle={() => setExpanded((state) => ({ ...state, [agent]: !state[agent] }))}
                    onSelectAll={() => selectSection(sectionSkills, true)}
                    onDeselectAll={() => selectSection(sectionSkills, false)}
                    allSelected={allSelected}
                    noneSelected={noneSelected}
                  >
                    {sectionSkills.map((skill) => (
                      <ScanSkillRow
                        key={keyFor(skill)}
                        name={skill.name}
                        description={skill.description ?? ""}
                        descriptionTokenCount={skill.descriptionTokenCount ?? 0}
                        tokenCount={skill.tokenCount}
                        selected={selected.has(keyFor(skill))}
                        focused={flatVisibleSkills.indexOf(skill) === focusIndex}
                        onClick={() => toggle(skill)}
                      />
                    ))}
                  </CollapsibleSection>
                );
              })}
            </div>

            {mcpServers.length > 0 && (
              <div className="onboarding__mcp-section">
                <div className="onboarding__collapsible-header">
                  <span className="onboarding__collapsible-toggle" style={{ cursor: "default" }}>
                    MCP SERVERS ({mcpServers.length})
                  </span>
                </div>
                {mcpServers.map((server) => (
                  <div key={`${server.agent}:${server.name}`} className="onboarding__skill-row onboarding__skill-row--mcp">
                    <span className="onboarding__skill-name">{server.name}</span>
                    <span className="onboarding__mcp-meta">
                      <span className="onboarding__status-dot onboarding__status-dot--green" />
                      <span className="onboarding__skill-badge">{server.agent === "claude-code" ? "Claude" : "Codex"}</span>
                    </span>
                  </div>
                ))}
                <p className="onboarding__mcp-hint">MCP servers are displayed for reference. Draft does not sync MCP configurations.</p>
              </div>
            )}

            <div className="onboarding__import-footer">
              <span>{selected.size} of {total} selected</span>
              <div className="onboarding__actions">
                <button className="onboarding__skip" onClick={onNext} disabled={importing}>Skip</button>
                <button className="empty-state__cta onboarding__cta" onClick={() => void importSelected()} disabled={importing || selected.size === 0}>
                  {importing ? "Importing…" : "Import selected"}
                </button>
              </div>
            </div>
          </>
        )}

        {!isLoading && skills?.length === 0 && (
          <>
            <p className="onboarding__hint">No third-party skills found. You can install skills in Claude Code or Codex and Draft will detect them.</p>
            <div className="onboarding__actions" style={{ marginTop: 20 }}>
              {error && <button className="onboarding__skip" onClick={() => void loadSkills()}>Retry</button>}
              <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
            </div>
          </>
        )}
      </ScanErrorBoundary>
    </div>
  );
}
