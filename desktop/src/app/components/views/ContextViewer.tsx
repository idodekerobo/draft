// ContextViewer.tsx — context browser with team sync visibility
//
// Layout (top → bottom):
//   TeamSyncBar  — last loaded time, change count, Load button (hidden when collab not configured)
//   ChangelogPanel — diff entries; Apply action in HITL mode (hidden when no entries)
//   context-viewer__body — file tree (left) + markdown content (right)

import { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type { ContextFileEntry, LoadDiffEntry, LocalConfig, SessionPreview, TeamDiffResult } from "../../../rpc/schema";
import { rpc } from "../../rpc";

marked.setOptions({ breaks: true });

// ── Relative time helper ───────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── TeamSyncBar ────────────────────────────────────────────────────────────────

type SyncStatus = "idle" | "loading" | "loaded" | "applying" | "error";

interface TeamSyncBarProps {
  lastLoaded: string | null;
  pendingCount: number;
  status: SyncStatus;
  errorMsg: string;
  onLoad: () => void;
}

function TeamSyncBar({ lastLoaded, pendingCount, status, errorMsg, onLoad }: TeamSyncBarProps) {
  const isWorking = status === "loading" || status === "applying";

  return (
    <div className="sync-bar">
      <div className="sync-bar__left">
        {status === "error" ? (
          <span className="sync-bar__error">{errorMsg}</span>
        ) : (
          <>
            <span className="sync-bar__timestamp">
              Last loaded {relativeTime(lastLoaded)}
            </span>
            {pendingCount > 0 && (
              <>
                <span className="sync-bar__sep">·</span>
                <span className="sync-bar__count">
                  {pendingCount} {pendingCount === 1 ? "change" : "changes"}
                </span>
              </>
            )}
          </>
        )}
      </div>
      <button
        className="sync-bar__btn"
        onClick={onLoad}
        disabled={isWorking}
        aria-label="Load from team"
      >
        {status === "loading" ? "Loading…" : status === "applying" ? "Applying…" : "Load from team"}
      </button>
    </div>
  );
}

// ── ChangelogPanel ─────────────────────────────────────────────────────────────

interface ChangelogPanelProps {
  entries: LoadDiffEntry[];
  mode: "auto" | "review";
  isApplying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}

function ChangelogPanel({ entries, mode, isApplying, onApply, onDismiss }: ChangelogPanelProps) {
  return (
    <div className="changelog-panel">
      {entries.length === 0 ? (
        <p className="changelog-panel__empty">No changes since last load.</p>
      ) : (
        <ul className="changelog-panel__list">
          {entries.map((e, i) => (
            <li key={i} className="changelog-entry">
              <span className="changelog-entry__pill">{e.dimension || "context"}</span>
              <span className="changelog-entry__action">{e.action}</span>
              <span className="changelog-entry__summary">{e.summary}</span>
            </li>
          ))}
        </ul>
      )}

      {mode === "review" && entries.length > 0 && (
        <div className="changelog-actions">
          <button
            className="proposal-action proposal-action--primary changelog-actions__apply"
            onClick={onApply}
            disabled={isApplying}
          >
            {isApplying ? "Applying…" : "Apply"}
          </button>
          <button
            className="proposal-action proposal-action--ghost"
            onClick={onDismiss}
            disabled={isApplying}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function ContextEmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">◎</div>
      <p className="empty-state__title">No context files yet</p>
      <p className="empty-state__body">
        Run /draft-setup in Claude Code to populate your workspace context.
      </p>
    </div>
  );
}

// ── Tree item ─────────────────────────────────────────────────────────────────

function TreeItem({
  entry,
  isActive,
  onSelect,
  onContextMenu,
  extraClass,
}: {
  entry: ContextFileEntry;
  isActive: boolean;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  extraClass?: string;
}) {
  return (
    <button
      className={`context-tree__item${isActive ? " context-tree__item--active" : ""}${extraClass ? ` ${extraClass}` : ""}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={entry.label}
    >
      <span className="context-tree__item-label">{entry.label}</span>
    </button>
  );
}

// ── Dim row ───────────────────────────────────────────────────────────────────

function DimRow({
  dim,
  logs,
  selectedPath,
  isExpanded,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  dim: ContextFileEntry;
  logs: ContextFileEntry[];
  selectedPath: string;
  isExpanded: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
}) {
  const hasLogs = logs.length > 0;

  return (
    <div className="context-dim-row">
      <div className={`context-dim-row__main${dim.relativePath === selectedPath ? " context-dim-row__main--active" : ""}`}>
        <button
          className="context-dim-row__label"
          onClick={() => onSelect(dim.relativePath)}
          onContextMenu={(e) => onContextMenu?.(e, dim.relativePath)}
          title={dim.label}
        >
          <span className="context-tree__item-label">{dim.label}</span>
        </button>

        {hasLogs && (
          <button
            className={`context-dim-row__expand-btn${isExpanded ? " context-dim-row__expand-btn--expanded" : ""}`}
            onClick={onToggle}
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            ▶
          </button>
        )}
      </div>

      <div className={`context-dim-row__logs${isExpanded ? " context-dim-row__logs--expanded" : ""}`}>
        {logs.map((log) => (
          <button
            key={log.relativePath}
            className={`context-tree__item context-tree__item--log${log.relativePath === selectedPath ? " context-tree__item--active" : ""}`}
            onClick={() => onSelect(log.relativePath)}
            onContextMenu={(e) => onContextMenu?.(e, log.relativePath)}
            title={log.label}
          >
            <span className="context-tree__item-label">· {log.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Group section ─────────────────────────────────────────────────────────────

function GroupSection({
  groupId,
  groupLabel,
  children,
  selectedPath,
  isCollapsed,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  groupId: string;
  groupLabel: string;
  children: ContextFileEntry[];
  selectedPath: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
}) {
  return (
    <div className="context-group-section">
      <button className="context-group-section__header" onClick={onToggle} title={groupLabel}>
        <span>{groupLabel.toUpperCase()}</span>
        <span
          className={`context-group-section__arrow${isCollapsed ? "" : " context-group-section__arrow--expanded"}`}
          aria-hidden="true"
        >
          ▶
        </span>
      </button>

      <div className={`context-group-section__children${isCollapsed ? "" : " context-group-section__children--expanded"}`}>
        {children.map((entry) => (
          <TreeItem
            key={entry.relativePath}
            entry={entry}
            isActive={entry.relativePath === selectedPath}
            onSelect={() => onSelect(entry.relativePath)}
            onContextMenu={(e) => onContextMenu?.(e, entry.relativePath)}
            extraClass="context-tree__item--group-child"
          />
        ))}
      </div>
    </div>
  );
}

// ── Context tree ──────────────────────────────────────────────────────────────

function ContextTree({
  files,
  selectedPath,
  expandedDims,
  collapsedGroups,
  onSelect,
  onToggleDim,
  onToggleGroup,
  onContextMenu,
}: {
  files: ContextFileEntry[];
  selectedPath: string;
  expandedDims: Set<string>;
  collapsedGroups: Set<string>;
  onSelect: (path: string) => void;
  onToggleDim: (group: string) => void;
  onToggleGroup: (group: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
}) {
  const dims = files.filter((f) => f.kind === "dim");
  const standalones = files.filter((f) => f.kind === "standalone");

  const groupIds: string[] = [];
  const groupMap = new Map<string, ContextFileEntry[]>();
  for (const f of files) {
    if (f.kind !== "group-child") continue;
    if (!groupMap.has(f.group)) {
      groupIds.push(f.group);
      groupMap.set(f.group, []);
    }
    groupMap.get(f.group)!.push(f);
  }

  const logMap = new Map<string, ContextFileEntry[]>();
  for (const f of files) {
    if (f.kind !== "log") continue;
    if (!logMap.has(f.group)) logMap.set(f.group, []);
    logMap.get(f.group)!.push(f);
  }

  return (
    <aside className="context-viewer__tree" aria-label="Context files">
      {dims.map((dim) => (
        <DimRow
          key={dim.relativePath}
          dim={dim}
          logs={logMap.get(dim.group) ?? []}
          selectedPath={selectedPath}
          isExpanded={expandedDims.has(dim.group)}
          onToggle={() => onToggleDim(dim.group)}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}

      {standalones.map((entry) => (
        <TreeItem
          key={entry.relativePath}
          entry={entry}
          isActive={entry.relativePath === selectedPath}
          onSelect={() => onSelect(entry.relativePath)}
          onContextMenu={(e) => onContextMenu?.(e, entry.relativePath)}
        />
      ))}

      {groupIds.map((gid) => {
        const children = groupMap.get(gid)!;
        const label = children[0]?.groupLabel ?? gid;
        return (
          <GroupSection
            key={gid}
            groupId={gid}
            groupLabel={label}
            children={children}
            selectedPath={selectedPath}
            isCollapsed={collapsedGroups.has(gid)}
            onToggle={() => onToggleGroup(gid)}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
          />
        );
      })}
    </aside>
  );
}

// ── Content panel ─────────────────────────────────────────────────────────────

function ContextContent({ entry }: { entry: ContextFileEntry }) {
  const html = marked.parse(entry.content) as string;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const anchor = target.tagName === "A" ? target : target.closest("a");
      if (!anchor) return;
      const href = (anchor as HTMLAnchorElement).href;
      if (!href) return;
      e.preventDefault();
      rpc.send.openUrl({ url: href });
    }

    el.addEventListener("click", handleClick);
    return () => el.removeEventListener("click", handleClick);
  }, []);

  return (
    <div className="context-content" ref={containerRef}>
      <div
        className="context-content__markdown"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

// ── Session preview panel ─────────────────────────────────────────────────

function SessionPreviewPanel({ preview, loading }: { preview: SessionPreview | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="context-session-panel">
        <div className="context-session-meta" />
        <div className="context-session-scroll context-session-scroll--loading">
          <span className="context-session-loading">Loading preview…</span>
        </div>
      </div>
    );
  }

  if (!preview || !preview.text) {
    return (
      <div className="context-session-panel">
        <div className="context-session-meta" />
        <ContextEmptyState />
      </div>
    );
  }

  const formatted = preview.tokenEstimate >= 1000
    ? `~${(preview.tokenEstimate / 1000).toFixed(1)}k tokens`
    : `~${preview.tokenEstimate} tokens`;

  return (
    <div className="context-session-panel">
      <div className="context-session-meta">
        <span className="context-token-pill">
          <span className="context-token-pill__dot" />
          {formatted}
        </span>
        <span className="context-session-meta__note">injected at every session start</span>
      </div>
      <div className="context-session-scroll">
        <pre className="context-session-pre">{preview.text}</pre>
      </div>
    </div>
  );
}

// ── Context menu ──────────────────────────────────────────────────────────

interface CtxMenuState {
  x: number;
  y: number;
  relativePath: string;
}

function ContextMenu({ state, onReveal, onClose }: {
  state: CtxMenuState;
  onReveal: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Flip left if near right edge
  const x = Math.min(state.x, window.innerWidth - 180);
  const y = Math.min(state.y + 2, window.innerHeight - 48);

  return (
    <div
      ref={ref}
      className="context-ctx-menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      <button
        className="context-ctx-menu__item"
        role="menuitem"
        onClick={() => { onReveal(); onClose(); }}
      >
        Reveal in Finder
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface ContextViewerProps {
  activeProfile: string;
  onNewChanges: (hasNew: boolean) => void;
}

export function ContextViewer({ activeProfile, onNewChanges }: ContextViewerProps) {
  // ── File tree state ──────────────────────────────────────────────────────────
  const [files, setFiles] = useState<ContextFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [expandedDims, setExpandedDims] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // ── View mode + session preview ──────────────────────────────────────────────
  const [mode, setMode] = useState<"browse" | "session">("browse");
  const [sessionPreview, setSessionPreview] = useState<SessionPreview | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  // ── Context menu ─────────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  // ── Sync state ───────────────────────────────────────────────────────────────
  const [localConfig, setLocalConfig] = useState<LocalConfig>({ teamLoadMode: "auto", launchOnLogin: false, notificationsEnabled: true, disabledContextSections: [] });
  const [collabConfigured, setCollabConfigured] = useState(false);
  const [lastLoaded, setLastLoaded] = useState<string | null>(null);
  const [localEntries, setLocalEntries] = useState<LoadDiffEntry[]>([]);
  const [localCursor, setLocalCursor] = useState(0);

  // Staged remote diff (HITL mode — held between getTeamDiff and applyTeamDiff)
  const [stagedDiff, setStagedDiff] = useState<TeamDiffResult | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncError, setSyncError] = useState("");

  // ── Reset view state when profile switches ───────────────────────────────────
  useEffect(() => {
    setMode("browse");
    setSessionPreview(null);
    setCtxMenu(null);
  }, [activeProfile]);

  // ── Session preview ───────────────────────────────────────────────────────────
  function fetchSessionPreview() {
    if (sessionPreview) return; // already loaded
    setSessionLoading(true);
    rpc.request.getSessionPreview()
      .then((p) => { setSessionPreview(p); setSessionLoading(false); })
      .catch(() => setSessionLoading(false));
  }

  function handleModeSwitch(m: "browse" | "session") {
    setMode(m);
    if (m === "session") fetchSessionPreview();
  }

  // ── Context menu handler ──────────────────────────────────────────────────────
  function handleContextMenu(e: React.MouseEvent, relativePath: string) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, relativePath });
  }

  // ── Load context files ───────────────────────────────────────────────────────
  function loadFiles() {
    rpc.request.getContextFiles().then((result) => {
      setFiles(result);
      if (result.length > 0) {
        const firstSelectable = result.find(
          (f) => f.kind === "dim" || f.kind === "standalone" || f.kind === "group-child"
        );
        setSelectedPath((prev) => prev || (firstSelectable?.relativePath ?? result[0].relativePath));
      }
    }).catch(() => setFiles([]));
  }

  // ── Load local diff (option B: check on mount, not on poll) ─────────────────
  function refreshLocalDiff() {
    rpc.request.loadDiff().then((result) => {
      setLastLoaded(result.lastLoaded);
      setLocalEntries(result.entries);
      setLocalCursor(result.cursorLine);
      // Signal App.tsx: new entries exist that haven't been seen yet
      onNewChanges(result.entries.length > 0);
    }).catch(() => {});
  }

  // ── On mount ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    loadFiles();
    refreshLocalDiff();

    rpc.request.getLocalConfig().then((cfg) => setLocalConfig(cfg)).catch(() => {});

    // Check if collab is configured via getTeamDiff probe (collabConfigured field)
    // We don't clone — just need to know whether to show the sync bar.
    // Use getLocalConfig as proxy; check collaboration via a lightweight path.
    // For now: attempt loadDiff — if it returns a lastLoaded timestamp, collab was used at least once.
    // Full collabConfigured truth comes from the first getTeamDiff call.
    // Show sync bar speculatively if last_loaded is set.
    rpc.request.loadDiff().then((result) => {
      if (result.lastLoaded) setCollabConfigured(true);
    }).catch(() => {});
  }, []);

  // ── "Load from team" handler ─────────────────────────────────────────────────
  const handleLoad = useCallback(async () => {
    setSyncStatus("loading");
    setSyncError("");
    setStagedDiff(null);

    try {
      const diff = await rpc.request.getTeamDiff();
      setCollabConfigured(diff.collabConfigured);

      if (!diff.collabConfigured) {
        setSyncStatus("idle");
        return;
      }

      if (localConfig.teamLoadMode === "review") {
        // HITL: stage the diff, show changelog with Apply button
        setStagedDiff(diff);
        setLocalEntries(diff.entries);
        setShowChangelog(true);
        setSyncStatus("loaded");
      } else {
        // Auto: apply immediately
        setSyncStatus("applying");
        const apply = await rpc.request.applyTeamDiff({ tmpDir: diff.tmpDir, cursorLine: diff.cursorLine });
        if (!apply.ok) throw new Error(apply.error ?? "Apply failed.");
        setLastLoaded(new Date().toISOString());
        setLocalEntries(diff.entries);
        setLocalCursor(diff.cursorLine);
        setShowChangelog(diff.entries.length > 0);
        setSyncStatus("loaded");
        onNewChanges(false); // user triggered this — they're seeing it now
        loadFiles(); // refresh tree with newly applied context
      }
    } catch (err) {
      setSyncStatus("error");
      setSyncError(err instanceof Error ? err.message : "Sync failed.");
    }
  }, [localConfig.teamLoadMode]);

  // ── HITL Apply ───────────────────────────────────────────────────────────────
  async function handleApply() {
    if (!stagedDiff?.tmpDir) return;
    setSyncStatus("applying");
    try {
      const result = await rpc.request.applyTeamDiff({
        tmpDir: stagedDiff.tmpDir,
        cursorLine: stagedDiff.cursorLine,
      });
      if (!result.ok) throw new Error(result.error ?? "Apply failed.");
      setLastLoaded(new Date().toISOString());
      setLocalCursor(stagedDiff.cursorLine);
      setStagedDiff(null);
      setSyncStatus("loaded");
      onNewChanges(false);
      loadFiles();
    } catch (err) {
      setSyncStatus("error");
      setSyncError(err instanceof Error ? err.message : "Apply failed.");
    }
  }

  function handleDismiss() {
    setStagedDiff(null);
    setShowChangelog(false);
    setSyncStatus("idle");
  }

  // ── Mode toggle (called from settings, reflected immediately) ────────────────
  // ContextViewer doesn't expose a toggle directly — Settings tab calls setLocalConfig.
  // Re-read on focus via a storage event is v2. For now, Settings changes take effect
  // on next "Load from team" press (mode is read at handleLoad time).

  function toggleDim(group: string) {
    setExpandedDims((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const selectedEntry = files.find((f) => f.relativePath === selectedPath) ?? null;

  const changelogEntries = stagedDiff ? stagedDiff.entries : localEntries;
  const isApplying = syncStatus === "applying";

  if (files.length === 0) {
    return (
      <div className="context-viewer">
        {collabConfigured && (
          <TeamSyncBar
            lastLoaded={lastLoaded}
            pendingCount={localEntries.length}
            status={syncStatus}
            errorMsg={syncError}
            onLoad={handleLoad}
          />
        )}
        <ContextEmptyState />
      </div>
    );
  }

  return (
    <div className="context-viewer">
      <div className="context-viewer__header">
        <span className="proposals__title">Context</span>
        <div className="segment-control">
          <button
            className={`segment-control__btn${mode === "browse" ? " segment-control__btn--active" : ""}`}
            onClick={() => handleModeSwitch("browse")}
          >
            Browse
          </button>
          <button
            className={`segment-control__btn${mode === "session" ? " segment-control__btn--active" : ""}`}
            onClick={() => handleModeSwitch("session")}
          >
            Session
          </button>
        </div>
      </div>

      {collabConfigured && (
        <TeamSyncBar
          lastLoaded={lastLoaded}
          pendingCount={localEntries.length}
          status={syncStatus}
          errorMsg={syncError}
          onLoad={handleLoad}
        />
      )}

      {showChangelog && (
        <ChangelogPanel
          entries={changelogEntries}
          mode={localConfig.teamLoadMode}
          isApplying={isApplying}
          onApply={handleApply}
          onDismiss={handleDismiss}
        />
      )}

      {mode === "session" ? (
        <SessionPreviewPanel preview={sessionPreview} loading={sessionLoading} />
      ) : (
        <div className="context-viewer__body">
          <ContextTree
            files={files}
            selectedPath={selectedPath}
            expandedDims={expandedDims}
            collapsedGroups={collapsedGroups}
            onSelect={setSelectedPath}
            onToggleDim={toggleDim}
            onToggleGroup={toggleGroup}
            onContextMenu={handleContextMenu}
          />
          {selectedEntry && <ContextContent entry={selectedEntry} />}
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          onReveal={() => rpc.request.revealInFinder({ relativePath: ctxMenu.relativePath })}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
