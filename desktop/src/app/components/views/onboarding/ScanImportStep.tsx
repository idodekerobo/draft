import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PendingMcpEntry, ScannedSkillEntry, ScanDirError } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { ScanSkillRow, CollapsibleSection } from "./shared";
import { AGENT_LABELS, skillKey, type Agent } from "../../shared/skills";

interface ScanImportStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function displayMcpUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

// ── McpRow ────────────────────────────────────────────────────────────────────

function McpRow({ mcp, selected, onClick }: {
  mcp: PendingMcpEntry;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="onboarding__skill-row"
      role="option"
      aria-selected={selected}
      onClick={onClick}
    >
      <span className="onboarding__skill-check">{selected ? "✓" : ""}</span>
      <span className="onboarding__skill-info">
        <span className="onboarding__skill-name" style={{ fontFamily: "var(--font-ui)" }}>
          {mcp.name}
        </span>
        <span className="onboarding__skill-badge">
          {AGENT_LABELS[mcp.source_agent]} · {displayMcpUrl(mcp.canonical.url)}
        </span>
      </span>
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ScanImportStep({ stepNum, totalSteps, onBack, onNext }: ScanImportStepProps) {
  // Skills state
  const [skills, setSkills]         = useState<ScannedSkillEntry[] | null>(null);
  const [scanErrors, setScanErrors]  = useState<ScanDirError[]>([]);
  const [selected, setSelected]      = useState<Set<string>>(new Set());
  const [expanded, setExpanded]      = useState<Record<Agent, boolean>>({ "claude-code": false, codex: false });
  const [query, setQuery]            = useState("");
  const [focusIndex, setFocusIndex]  = useState(-1);
  const listRef                      = useRef<HTMLDivElement>(null);
  const retryKey                     = useRef(0);

  // MCP state
  const [pendingMcps, setPendingMcps]     = useState<PendingMcpEntry[]>([]);
  const [selectedMcps, setSelectedMcps]   = useState<Set<string>>(new Set());

  // Shared async state
  const [syncing, setSyncing] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // ── Load ───────────────────────────────────────────────────────────────────

  async function loadSkills() {
    setSkills(null);
    setError(null);
    setScanErrors([]);
    try {
      const [skillsResult, mcpResult] = await Promise.all([
        rpc.request.scanSkills(),
        rpc.request.getMcpPending(),
      ]);
      if (skillsResult.skills.length === 0 && mcpResult.pending.length === 0) {
        onNext();
        return;
      }
      setSkills(skillsResult.skills);
      setScanErrors(skillsResult.scanErrors ?? []);
      setSelected(new Set(skillsResult.skills.map(skillKey)));
      const sorted = [...mcpResult.pending].sort((a, b) => a.name.localeCompare(b.name));
      setPendingMcps(sorted);
      setSelectedMcps(new Set(sorted.map((m) => m.id)));
    } catch {
      setError("Could not scan skill directories. Check file permissions.");
      setSkills([]);
    }
  }

  useEffect(() => { void loadSkills(); }, []);

  // ── Sync actions ───────────────────────────────────────────────────────────

  async function syncSelected() {
    setSyncing(true);
    setError(null);
    try {
      const selectedSkills = (skills ?? []).filter((s) => selected.has(skillKey(s)));
      const selectedMcpList = pendingMcps.filter((m) => selectedMcps.has(m.id));

      const [skillResult, mcpResult] = await Promise.all([
        selectedSkills.length > 0
          ? rpc.request.importSkills({ skills: selectedSkills })
          : Promise.resolve({ ok: true as const }),
        selectedMcpList.length > 0
          ? rpc.request.approveMcps({ mcps: selectedMcpList })
          : Promise.resolve({ ok: true as const }),
      ]);

      if (!skillResult.ok) {
        setError((skillResult as { ok: false; error?: string }).error ?? "Some skills could not be imported. Try again or skip.");
        return;
      }
      if (!mcpResult.ok) {
        setError((mcpResult as { ok: false; error?: string }).error ?? "Some MCP servers could not be synced. Try again or skip.");
        return;
      }
      onNext();
    } catch {
      setError("Could not complete sync. Try again or skip this step.");
    } finally {
      setSyncing(false);
    }
  }

  async function syncAll() {
    setSyncing(true);
    setError(null);
    try {
      const [skillResult, mcpResult] = await Promise.all([
        (skills ?? []).length > 0
          ? rpc.request.importSkills({ skills: skills ?? [] })
          : Promise.resolve({ ok: true as const }),
        pendingMcps.length > 0
          ? rpc.request.approveMcps({ mcps: pendingMcps })
          : Promise.resolve({ ok: true as const }),
      ]);

      if (!skillResult.ok) {
        setError((skillResult as { ok: false; error?: string }).error ?? "Some skills could not be imported. Try again or skip.");
        return;
      }
      if (!mcpResult.ok) {
        setError((mcpResult as { ok: false; error?: string }).error ?? "Some MCP servers could not be synced. Try again or skip.");
        return;
      }
      onNext();
    } catch {
      setError("Could not complete sync. Try again or skip this step.");
    } finally {
      setSyncing(false);
    }
  }

  // ── Skills helpers ─────────────────────────────────────────────────────────

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
    const key = skillKey(skill);
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
        const key = skillKey(skill);
        if (shouldSelect) next.add(key); else next.delete(key);
      }
      return next;
    });
  }

  function toggleMcp(id: string) {
    setSelectedMcps((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
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
      toggle(flatVisibleSkills[focusIndex]!);
    }
  }, [flatVisibleSkills, focusIndex]);

  useEffect(() => {
    if (focusIndex < 0) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    rows?.[focusIndex]?.focus();
  }, [focusIndex]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const total = skills?.length ?? 0;
  const isLoading = skills === null && error === null;
  const hasSelection = selected.size > 0 || selectedMcps.size > 0;
  const allMcpsSelected = pendingMcps.length > 0 && pendingMcps.every((m) => selectedMcps.has(m.id));

  function selectionLabel(): string {
    const parts: string[] = [];
    if (total > 0) parts.push(`${selected.size}/${total} skills`);
    if (pendingMcps.length > 0) parts.push(`${selectedMcps.size}/${pendingMcps.length} MCP server${pendingMcps.length !== 1 ? "s" : ""}`);
    return parts.join(" · ");
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="onboarding__body onboarding__body--wide">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Your existing tools</h1>
      <p className="onboarding__desc">
        {isLoading
          ? "Scanning your agent tools…"
          : `Draft found ${total} skill${total === 1 ? "" : "s"}${pendingMcps.length > 0 ? ` and ${pendingMcps.length} MCP server${pendingMcps.length !== 1 ? "s" : ""}` : ""} across your agent tools. Select what to import.`
        }
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

        {/* ── Skills ─────────────────────────────────────────────────────── */}
        {!isLoading && skills && skills.length > 0 && (
          <>
            <input
              className="onboarding__search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter skills…"
              aria-label="Filter skills"
            />
            <p className="onboarding__sr-only" aria-live="polite">
              {grouped.reduce((count, group) => count + group.skills.length, 0)} skills match your filter.
            </p>
            <div className="onboarding__skill-list-header">
              <span>Skill</span>
              <span title="Approximate token count for the full SKILL.md file">Tokens</span>
            </div>
            <div
              className="onboarding__skill-list"
              role="listbox"
              aria-multiselectable="true"
              ref={listRef}
              onKeyDown={handleKeyDown}
              tabIndex={0}
            >
              {grouped.map(({ agent, skills: sectionSkills }, groupIndex) => {
                const allSelected = sectionSkills.length > 0 && sectionSkills.every((skill) => selected.has(skillKey(skill)));
                const noneSelected = sectionSkills.every((skill) => !selected.has(skillKey(skill)));
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
                        key={skillKey(skill)}
                        name={skill.name}
                        description={skill.description ?? ""}
                        descriptionTokenCount={skill.descriptionTokenCount ?? 0}
                        tokenCount={skill.tokenCount}
                        selected={selected.has(skillKey(skill))}
                        focused={flatVisibleSkills.indexOf(skill) === focusIndex}
                        onClick={() => toggle(skill)}
                      />
                    ))}
                  </CollapsibleSection>
                );
              })}
            </div>
          </>
        )}

        {!isLoading && skills?.length === 0 && (
          <p className="onboarding__hint">
            No third-party skills found. You can install skills in Claude Code or Codex and Draft will detect them.
          </p>
        )}

        {/* ── MCP Servers ─────────────────────────────────────────────────── */}
        {!isLoading && pendingMcps.length > 0 && (
          <div className="onboarding__mcp-section">
            <div className="onboarding__skill-list-header">
              <span>MCP Servers</span>
              <button
                className="onboarding__mcp-select-toggle"
                onClick={() =>
                  allMcpsSelected
                    ? setSelectedMcps(new Set())
                    : setSelectedMcps(new Set(pendingMcps.map((m) => m.id)))
                }
              >
                {allMcpsSelected ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="onboarding__skill-list" role="listbox" aria-multiselectable="true">
              {pendingMcps.map((mcp) => (
                <McpRow
                  key={mcp.id}
                  mcp={mcp}
                  selected={selectedMcps.has(mcp.id)}
                  onClick={() => toggleMcp(mcp.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Unified footer ───────────────────────────────────────────────── */}
        {!isLoading && (total > 0 || pendingMcps.length > 0) && (
          <div className="onboarding__import-footer">
            <span>{selectionLabel()}</span>
            <div className="onboarding__actions">
              <button className="onboarding__skip" onClick={onNext} disabled={syncing}>
                Skip
              </button>
              <button
                className="onboarding__cta-secondary"
                onClick={() => void syncAll()}
                disabled={syncing}
              >
                {syncing ? "Syncing…" : "Sync all"}
              </button>
              <button
                className="empty-state__cta onboarding__cta"
                onClick={() => void syncSelected()}
                disabled={syncing || !hasSelection}
              >
                {syncing ? "Syncing…" : "Sync selected"}
              </button>
            </div>
          </div>
        )}

        {/* No-skills + no-MCPs fallback Continue (shouldn't normally render since loadSkills auto-advances) */}
        {!isLoading && total === 0 && pendingMcps.length === 0 && (
          <div className="onboarding__actions" style={{ marginTop: 20 }}>
            <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
          </div>
        )}
      </ScanErrorBoundary>
    </div>
  );
}
