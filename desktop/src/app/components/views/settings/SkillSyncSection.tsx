import { useEffect, useMemo, useRef, useState } from "react";
import type { ScannedSkillEntry, ScanDirError, PendingSkillEntry, SameNameConflict } from "../../../../rpc/schema";
import { rpc, events } from "../../../rpc";
import { AGENT_LABELS, formatTokens, skillKey } from "../../shared/skills";

interface SkillSyncSectionProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

// ── PendingGroup ──────────────────────────────────────────────────────────────

function PendingGroup({ pending, onApprove, approving, exitingIds }: {
  pending: PendingSkillEntry[];
  onApprove: (skills: PendingSkillEntry[]) => void;
  approving: boolean;
  exitingIds: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");

  if (pending.length === 0) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? pending.filter((p) => p.name.toLowerCase().includes(normalizedQuery))
    : pending;

  return (
    <div>
      <button
        className="skill-agent-group__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="skill-agent-group__toggle">{expanded ? "▼" : "▶"}</span>
        <span className="skill-agent-group__label">
          {pending.length} new skill{pending.length !== 1 ? "s" : ""} detected
        </span>
        <span className="skill-agent-group__count">pending sync</span>
      </button>

      {expanded && (
        <>
          <div className="skill-sync__filter-bar">
            <input
              className="skill-sync__filter-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter pending skills"
            />
            {query && (
              <button className="skill-sync__filter-clear" onClick={() => setQuery("")} aria-label="Clear filter">✕</button>
            )}
          </div>

          {/* Batch action row — outside the scroll area so it stays anchored */}
          <div className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__meta">
                  Sync to share these skills across both Claude Code and Codex
                </span>
              </div>
            </div>
            <button
              className="app-row__connect"
              onClick={() => onApprove(pending)}
              disabled={approving}
            >
              {approving ? "Syncing…" : "Sync all"}
            </button>
          </div>

          <div className="skill-sync__section-items">
            {filtered.map((p) => (
              <div
                key={p.id}
                className={`skill-row-anim${exitingIds.has(p.id) ? " skill-row-anim--exit-left" : ""}`}
              >
                <div className="app-row">
                  <div className="app-row__left">
                    <span className="app-row__status-dot app-row__status-dot--pending" />
                    <div className="app-row__text">
                      <span className="app-row__name">{p.name}</span>
                      <span className="app-row__meta">
                        {AGENT_LABELS[p.source_agent]} · ~{formatTokens(p.tokenCount)} tokens
                      </span>
                      {p.description && (
                        <span className="app-row__hint">{p.description}</span>
                      )}
                    </div>
                  </div>
                  <button
                    className="app-row__connect"
                    onClick={() => onApprove([p])}
                    disabled={approving}
                  >
                    Sync
                  </button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="app-row">
                <span className="app-row__meta" style={{ padding: "0 20px" }}>No skills match &ldquo;{query}&rdquo;</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── SyncedGroup ───────────────────────────────────────────────────────────────
// Shows all approved/synced skills in one flat list, with a Remove button.

function SyncedGroup({ skills, onRemove, removingKey, exitingKeys }: {
  skills: ScannedSkillEntry[];
  onRemove: (skill: ScannedSkillEntry) => void;
  removingKey: string | null;
  exitingKeys: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const prevKeysRef = useRef<Set<string>>(new Set());

  const totalCount = skills.length;
  if (totalCount === 0) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const filteredUser = normalizedQuery
    ? skills.filter((s) => s.name.toLowerCase().includes(normalizedQuery))
    : skills;

  const currentKeys = new Set(skills.map(skillKey));
  const newlyAddedKeys = prevKeysRef.current.size > 0
    ? new Set([...currentKeys].filter((k) => !prevKeysRef.current.has(k)))
    : new Set<string>();

  useEffect(() => { prevKeysRef.current = new Set(skills.map(skillKey)); });

  return (
    <div className="skill-agent-group">
      <button
        className="skill-agent-group__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="skill-agent-group__toggle">{expanded ? "▼" : "▶"}</span>
        <span className="skill-agent-group__label">Synced skills</span>
        <span className="skill-agent-group__count">{totalCount} synced</span>
      </button>
      {expanded && (
        <>
          <div className="skill-sync__filter-bar">
            <input
              className="skill-sync__filter-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter synced skills"
            />
            {query && (
              <button className="skill-sync__filter-clear" onClick={() => setQuery("")} aria-label="Clear filter">✕</button>
            )}
          </div>
          <div className="skill-sync__section-items">
            {filteredUser.map((skill) => {
              const key = skillKey(skill);
              const isExiting = exitingKeys.has(key);
              const isNew = newlyAddedKeys.has(key);
              return (
                <div
                  key={key}
                  className={`skill-row-anim${isExiting ? " skill-row-anim--exit-right" : isNew ? " skill-row-anim--enter" : ""}`}
                >
                  <div className="app-row">
                    <div className="app-row__left">
                      <span className="app-row__status-dot app-row__status-dot--on" />
                      <div className="app-row__text">
                        <span className="app-row__name">{skill.name}</span>
                        <span className="app-row__meta">
                          {AGENT_LABELS[skill.agent]} · ~{formatTokens(skill.tokenCount)} tokens
                        </span>
                        {skill.description && (
                          <span className="app-row__hint">{skill.description}</span>
                        )}
                      </div>
                    </div>
                    <div className="app-row__actions">
                      <button
                        className="app-row__disconnect"
                        onClick={() => onRemove(skill)}
                        disabled={removingKey === key || isExiting}
                      >
                        {removingKey === key ? "Removing…" : "Remove"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {filteredUser.length === 0 && (
              <div className="app-row">
                <span className="app-row__meta" style={{ padding: "0 20px" }}>No skills match &ldquo;{query}&rdquo;</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── ConflictGroup ─────────────────────────────────────────────────────────────

function ConflictGroup({ conflict, onResolve, resolving }: {
  conflict: SameNameConflict;
  onResolve: (conflict: SameNameConflict, action: "claude-code" | "codex" | "keep-local") => void;
  resolving: boolean;
}) {
  return (
    <div>
      <div className="skill-agent-group__header">
        <span className="skill-agent-group__label">Conflict: &ldquo;{conflict.name}&rdquo;</span>
        <span className="skill-agent-group__count">both agents have this skill — pick a source</span>
      </div>

      <div className="app-row">
        <div className="app-row__left">
          <span className="app-row__status-dot app-row__status-dot--pending" />
          <div className="app-row__text">
            <span className="app-row__name">Use Claude Code&apos;s version</span>
            <span className="app-row__hint">{conflict["claude-code"].path}</span>
          </div>
        </div>
        <button
          className="app-row__connect"
          onClick={() => onResolve(conflict, "claude-code")}
          disabled={resolving}
        >
          Use this
        </button>
      </div>

      <div className="app-row">
        <div className="app-row__left">
          <span className="app-row__status-dot app-row__status-dot--pending" />
          <div className="app-row__text">
            <span className="app-row__name">Use Codex&apos;s version</span>
            <span className="app-row__hint">{conflict.codex.path}</span>
          </div>
        </div>
        <button
          className="app-row__connect"
          onClick={() => onResolve(conflict, "codex")}
          disabled={resolving}
        >
          Use this
        </button>
      </div>

      <div className="app-row">
        <div className="app-row__left">
          <span className="app-row__status-dot" />
          <div className="app-row__text">
            <span className="app-row__name">Keep both local</span>
            <span className="app-row__hint">Neither will be synced — Draft won&apos;t manage this skill</span>
          </div>
        </div>
        <button
          className="app-row__disconnect"
          onClick={() => onResolve(conflict, "keep-local")}
          disabled={resolving}
        >
          Keep local
        </button>
      </div>
    </div>
  );
}

// ── SkillSyncSection ──────────────────────────────────────────────────────────

const ANIM_DURATION_MS = 260;

export function SkillSyncSection({ onError }: SkillSyncSectionProps) {
  const [skills, setSkills] = useState<ScannedSkillEntry[] | null>(null);
  const [scanErrors, setScanErrors] = useState<ScanDirError[]>([]);
  const [scanning, setScanning] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingSkillEntry[]>([]);
  const [conflicts, setConflicts] = useState<SameNameConflict[]>([]);
  const [approving, setApproving] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);

  const [exitingPendingIds, setExitingPendingIds] = useState<Set<string>>(new Set());
  const [exitingSyncedKeys, setExitingSyncedKeys] = useState<Set<string>>(new Set());

  async function scan() {
    setScanning(true);
    try {
      const [skillsResult, pendingResult] = await Promise.all([
        rpc.request.scanSkills(),
        rpc.request.getSkillsPending(),
      ]);
      setSkills([...skillsResult.skills].sort((a, b) => a.name.localeCompare(b.name)));
      setScanErrors(skillsResult.scanErrors ?? []);
      setPending([...pendingResult.pending].sort((a, b) => a.name.localeCompare(b.name)));
      setConflicts(pendingResult.conflicts);
    } catch {
      onError("Could not scan skill directories.");
      setSkills([]);
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => { void scan(); }, []);

  // Re-scan when the main process reports skills changed (e.g. after draft load).
  useEffect(() => events.on("skillsChanged", () => { void scan(); }), []);

  async function handleRemove(skill: ScannedSkillEntry) {
    const key = skillKey(skill);
    setExitingSyncedKeys(new Set([key]));
    await new Promise(r => setTimeout(r, ANIM_DURATION_MS));
    setRemovingKey(key);
    try {
      const result = await rpc.request.removeSkills({ skills: [skill] });
      if (!result.ok) { onError(result.error ?? "Could not remove skill."); return; }
      await scan();
    } catch {
      onError("Skill removal failed.");
    } finally {
      setRemovingKey(null);
      setExitingSyncedKeys(new Set());
    }
  }

  async function handleApprove(skillsToApprove: PendingSkillEntry[]) {
    const ids = new Set(skillsToApprove.map(s => s.id));
    setExitingPendingIds(ids);
    await new Promise(r => setTimeout(r, ANIM_DURATION_MS));
    setApproving(true);
    try {
      const result = await rpc.request.approveSkills({ skills: skillsToApprove });
      if (!result.ok) { onError(result.error ?? "Could not sync skills."); return; }
      await scan();
    } catch {
      onError("Skill approval failed.");
    } finally {
      setApproving(false);
      setExitingPendingIds(new Set());
    }
  }

  async function handleResolveConflict(conflict: SameNameConflict, action: "claude-code" | "codex" | "keep-local") {
    setResolvingConflict(conflict.name);
    try {
      const resolution = action === "keep-local"
        ? { action: "keep-local" as const }
        : { action: "use-source" as const, authoritative_agent: action };

      const result = await rpc.request.resolveSkillConflict({ conflict, resolution });
      if (!result.ok) { onError(result.error ?? "Could not resolve conflict."); return; }
      await scan();
    } catch {
      onError("Conflict resolution failed.");
    } finally {
      setResolvingConflict(null);
    }
  }

  const syncedSkills = useMemo(() => (skills ?? []).filter((s) => s.synced), [skills]);
  const isLoading = skills === null;
  const hasSynced = syncedSkills.length > 0;
  const isEmpty = !isLoading && (skills ?? []).length === 0 && pending.length === 0 && conflicts.length === 0;

  return (
    <section className="settings__section settings__section--tool-sync">
      <div className="settings__section-header">
        <h2 className="settings__section-label">Sync Skills</h2>
        <button
          className="app-row__connect settings__section-action"
          onClick={() => void scan()}
          disabled={scanning}
        >
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <div className="settings__rows">
        {isLoading && (
          <div className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__meta">{scanning ? "Scanning skill directories…" : "Loading…"}</span>
              </div>
            </div>
          </div>
        )}

        {!isLoading && scanErrors.map((err) => (
          <div key={err.dir} className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__hint" style={{ color: "var(--color-status-yellow)" }}>
                  Could not read {AGENT_LABELS[err.agent]} skills directory
                </span>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && pending.length > 0 && (
          <PendingGroup
            pending={pending}
            onApprove={handleApprove}
            approving={approving}
            exitingIds={exitingPendingIds}
          />
        )}

        {!isLoading && conflicts.map((conflict) => (
          <ConflictGroup
            key={conflict.name}
            conflict={conflict}
            onResolve={handleResolveConflict}
            resolving={resolvingConflict === conflict.name}
          />
        ))}

        {!isLoading && hasSynced && (
          <SyncedGroup
            skills={syncedSkills}
            onRemove={handleRemove}
            removingKey={removingKey}
            exitingKeys={exitingSyncedKeys}
          />
        )}

        {isEmpty && (
          <div className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__name">No third-party skills found</span>
                <span className="app-row__meta">Install skills in Claude Code or Codex and they&apos;ll appear here</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
