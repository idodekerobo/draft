// ContextViewer.tsx — context browser with team sync visibility
//
// Layout (top → bottom):
//   TeamSyncBar  — last loaded time, change count, Load button (hidden when collab not configured)
//   ChangelogPanel — diff entries; Apply action in HITL mode (hidden when no entries)
//   context-viewer__body — file tree (left) + markdown content (right)

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { diffLines, type Change } from "diff";
import type { ContextFileEntry, ContextFileVersion, LoadDiffEntry, LocalConfig, SessionPreview, TeamDiffResult } from "../../../rpc/schema";
import { rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { ContextEditor, RawEditor, type EditorHandle } from "./ContextEditor";
import { HistoryPanel, DiffLines } from "./HistoryPanel";

// ── Compact nudge ─────────────────────────────────────────────────────────────

const COMPACT_THRESHOLD = 500;

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

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
  wc,
}: {
  dim: ContextFileEntry;
  logs: ContextFileEntry[];
  selectedPath: string;
  isExpanded: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  wc: number;
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
          {wc > COMPACT_THRESHOLD && (
            <span className="context-dim__word-count context-dim__word-count--warn">
              {wc}w
            </span>
          )}
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

// ── Add dimension row ────────────────────────────────────────────────────────
// Inline affordance at the bottom of the tree for scaffolding a custom dimension
// (context/<name>/index.md + log/) without leaving the desktop app. Mirrors
// `draft dimension add <name>` / the draft-add-dimension skill's scaffold step.

function AddDimensionRow({
  onAdd,
}: {
  onAdd: (name: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setValue("");
    setError(null);
  }

  async function submit() {
    const slug = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) {
      setError("Enter a name.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onAdd(slug);
    setSubmitting(false);
    if (result.ok) {
      close();
    } else {
      setError(result.error ?? "Failed to create dimension.");
    }
  }

  if (!open) {
    return (
      <button className="context-tree__add-dim-trigger" onClick={() => setOpen(true)}>
        + New dimension
      </button>
    );
  }

  return (
    <div className="context-tree__add-dim-form">
      <input
        ref={inputRef}
        className="context-tree__add-dim-input"
        value={value}
        placeholder="Dimension Name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") close();
        }}
        disabled={submitting}
      />
      <div className="context-tree__add-dim-actions">
        <button className="context-tree__add-dim-confirm" onClick={submit} disabled={submitting}>
          {submitting ? "Adding…" : "Add"}
        </button>
        <button className="context-tree__add-dim-cancel" onClick={close} disabled={submitting}>
          Cancel
        </button>
      </div>
      {error && <p className="context-tree__add-dim-error">{error}</p>}
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
  onAddDimension,
}: {
  files: ContextFileEntry[];
  selectedPath: string;
  expandedDims: Set<string>;
  collapsedGroups: Set<string>;
  onSelect: (path: string) => void;
  onToggleDim: (group: string) => void;
  onToggleGroup: (group: string) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  onAddDimension: (name: string) => Promise<{ ok: boolean; error?: string }>;
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
          wc={wordCount(dim.content)}
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

      <AddDimensionRow onAdd={onAddDimension} />
    </aside>
  );
}

// ── Frontmatter field parser ────────────────────────────────────────────────────
// entry.content is always already frontmatter-stripped (by the main process) — the
// raw block travels separately as entry.frontmatterRaw so it survives round-trip on
// save. This only extracts display fields (name/last_updated/source) from that block.

interface FrontmatterFields {
  name?: string;
  last_updated?: string;
  source?: string;
}

function parseFrontmatterFields(frontmatterRaw: string): FrontmatterFields {
  const match = frontmatterRaw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?$/);
  if (!match?.[1]) return {};

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value && value !== ">") fields[key] = value;
  }

  return { name: fields["name"], last_updated: fields["last_updated"], source: fields["source"] };
}

// ── Toolbar overflow menu ────────────────────────────────────────────────────
// Collapses "View raw"/"History"/"Publish file" into a "⋯" dropdown when the
// container (.context-content) is too narrow to show all of them — see the
// @container rule in index.css. Both the discrete buttons and this trigger
// exist in the DOM at all times; CSS decides which set is visible, so there's
// only one set of click handlers (passed in as `items`).

function ToolbarMenu({ items }: { items: Array<{ label: string; onClick: () => void; active?: boolean }> }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (!triggerRef.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        className="context-content__toolbar-menu-trigger"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} role="menu" className="context-content__toolbar-menu" style={{ top: pos.top, right: pos.right }}>
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`context-content__toolbar-menu__item${item.active ? " context-content__toolbar-menu__item--active" : ""}`}
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// ── Content panel ─────────────────────────────────────────────────────────────

function ContextContent({
  entry,
  isDismissed,
  onDismiss,
  historyOpen,
  onToggleHistory,
  onSaved,
}: {
  entry: ContextFileEntry;
  isDismissed: boolean;
  onDismiss: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onSaved: (relativePath: string, content: string, frontmatterRaw?: string) => void;
}) {
  const { name, last_updated, source } = parseFrontmatterFields(entry.frontmatterRaw);
  const hasMeta = name || last_updated || source;
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorHandle>(null);
  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [rawOpen, setRawOpen] = useState(false);
  const [publishStatus, setPublishStatus] = useState<PublishStatus>("idle");
  const [publishError, setPublishError] = useState<string | undefined>(undefined);
  const [publishConfirm, setPublishConfirm] = useState<PublishConfirmState | null>(null);
  const [collabConfigured, setCollabConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    rpc.request.getCollabConfigured().then((result) => setCollabConfigured(result.configured)).catch(() => setCollabConfigured(false));
  }, []);

  const wc = wordCount(entry.content);
  const showNudge = entry.kind === "dim" && wc > COMPACT_THRESHOLD && !isDismissed;

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

  function handleCopy() {
    navigator.clipboard.writeText(`/draft:compact ${entry.group}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  const metaParts = [
    name,
    last_updated ? `updated ${last_updated}` : undefined,
    source ? `source: ${source}` : undefined,
  ].filter(Boolean) as string[];

  async function handlePublish() {
    if (collabConfigured === false) {
      setPublishConfirm({ kind: "not-configured" });
      return;
    }

    await editorRef.current?.flushAndCheckpoint();

    const versions = await rpc.request.getFileHistory({ relativePath: entry.relativePath });
    const lastPublishedIndex = versions.findIndex((v) => v.publishedAt);
    const lastPublished = lastPublishedIndex === -1 ? null : versions[lastPublishedIndex];
    const newest = versions[0] ?? null;

    if (lastPublished && newest && lastPublished.id === newest.id) {
      setPublishConfirm({ kind: "nothing-to-publish" });
      return;
    }

    const beforeContent = lastPublished
      ? (await rpc.request.getFileVersionContent({ versionId: lastPublished.id }))?.content ?? ""
      : "";
    const afterContent = newest
      ? (await rpc.request.getFileVersionContent({ versionId: newest.id }))?.content ?? ""
      : entry.content;

    if (beforeContent === afterContent) {
      setPublishConfirm({ kind: "nothing-to-publish" });
      return;
    }

    setPublishConfirm({ kind: "diff", diffParts: diffLines(beforeContent, afterContent) });
  }

  async function confirmPublish() {
    setPublishConfirm(null);
    setPublishStatus("publishing");
    const result = await rpc.request.publishContextFile({ relativePath: entry.relativePath });
    if (result.ok) {
      setPublishStatus("published");
      setTimeout(() => setPublishStatus("idle"), 2500);
    } else {
      setPublishError(result.error ?? "Publish failed.");
      setPublishStatus("error");
      setTimeout(() => setPublishStatus("idle"), 4000);
    }
  }

  if (publishConfirm) {
    return (
      <PublishConfirmView
        state={publishConfirm}
        onConfirm={confirmPublish}
        onCancel={() => setPublishConfirm(null)}
      />
    );
  }

  return (
    <div className="context-content" ref={containerRef}>
      <div className="context-content__toolbar">
        {hasMeta && (
          <div className="context-meta-strip">
            {metaParts.map((part, i) => (
              <span key={part}>
                {i > 0 && <span className="context-meta-strip__sep"> · </span>}
                {part}
              </span>
            ))}
          </div>
        )}
        <div className="context-content__toolbar-right">
          <SaveIndicator status={saveStatus} />
          <PublishIndicator status={publishStatus} error={publishError} />
          <button
            className={`context-content__history-toggle${rawOpen ? " context-content__history-toggle--active" : ""}`}
            onClick={() => setRawOpen((prev) => !prev)}
          >
            {rawOpen ? "View rendered" : "View raw"}
          </button>
          <button
            className={`context-content__history-toggle${historyOpen ? " context-content__history-toggle--active" : ""}`}
            onClick={onToggleHistory}
          >
            History
          </button>
          <button
            className="context-content__publish-button"
            onClick={handlePublish}
            disabled={publishStatus === "publishing"}
          >
            Publish file
          </button>
          <ToolbarMenu
            items={[
              { label: rawOpen ? "View rendered" : "View raw", onClick: () => setRawOpen((prev) => !prev), active: rawOpen },
              { label: "History", onClick: onToggleHistory, active: historyOpen },
              { label: "Publish file", onClick: handlePublish, active: publishStatus !== "idle" },
            ]}
          />
        </div>
      </div>
      <div className="context-content__scroll">
        {showNudge && (
          <div className="compact-nudge">
            <div className="compact-nudge__body">
              <p className="compact-nudge__text">
                <strong>{entry.label}</strong> is getting long ({wc} words).
              </p>
              <span className="compact-nudge__cmd-label">Run in Claude Code:</span>
              <button className="compact-nudge__cmd" onClick={handleCopy} title="Click to copy">
                <span className="compact-nudge__cmd-text">/draft:compact {entry.group}</span>
                {copied
                  ? <span className="compact-nudge__cmd-copied">✓</span>
                  : <span className="compact-nudge__cmd-icon">⎘</span>
                }
              </button>
            </div>
            <button className="compact-nudge__dismiss" onClick={onDismiss} aria-label="Dismiss">✕</button>
          </div>
        )}
        {rawOpen ? (
          <RawEditor
            key={entry.relativePath}
            ref={editorRef}
            relativePath={entry.relativePath}
            initialRawContent={entry.frontmatterRaw + entry.content}
            onSaveStatusChange={setSaveStatus}
            onSaved={onSaved}
          />
        ) : (
          <ContextEditor
            key={entry.relativePath}
            ref={editorRef}
            relativePath={entry.relativePath}
            initialContent={entry.content}
            frontmatterRaw={entry.frontmatterRaw}
            onSaveStatusChange={setSaveStatus}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}

// ── History diff view ───────────────────────────────────────────────────────
// Renders inline in the main content area (in place of the editor) when a
// version is selected in the History sidebar — diffed against the previous
// version in that file's history.

function HistoryDiffView({
  relativePath,
  selectedVersionId,
  onClose,
}: {
  relativePath: string;
  selectedVersionId: string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<ContextFileVersion[]>([]);
  const [diffParts, setDiffParts] = useState<Change[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    rpc.request.getFileHistory({ relativePath }).then((result) => {
      if (!cancelled) setVersions(result);
    });
    return () => {
      cancelled = true;
    };
  }, [relativePath]);

  const index = versions.findIndex((v) => v.id === selectedVersionId);
  const current = index === -1 ? null : versions[index];
  // versions is ordered newest-first, so the previous edit is the next entry in the list.
  const previous = index === -1 ? null : (versions[index + 1] ?? null);

  useEffect(() => {
    if (index === -1) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      previous ? rpc.request.getFileVersionContent({ versionId: previous.id }) : Promise.resolve(null),
      rpc.request.getFileVersionContent({ versionId: selectedVersionId }),
    ]).then(([before, after]) => {
      if (cancelled) return;
      setDiffParts(diffLines(before?.content ?? "", after?.content ?? ""));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersionId, previous?.id, index]);

  return (
    <div className="context-content">
      <div className="context-content__toolbar">
        <div className="context-meta-strip">
          {current ? `Version from ${relativeTime(current.createdAt)}` : "Version"}
          {current && !previous && (
            <>
              <span className="context-meta-strip__sep"> · </span>
              initial version
            </>
          )}
        </div>
        <div className="context-content__toolbar-right">
          <button className="context-content__history-toggle" onClick={onClose}>
            Back to editor
          </button>
        </div>
      </div>
      <div className="context-content__scroll">
        {loading || !diffParts ? (
          <div className="history-panel__loading">Loading diff…</div>
        ) : (
          <pre className="proposal-diff" aria-label="Version diff">
            <DiffLines parts={diffParts} />
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Save status indicator ────────────────────────────────────────────────────

type SaveStatus = "idle" | "saving" | "saved";

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  return (
    <span className={`context-save-indicator context-save-indicator--${status}`}>
      <span className="context-save-indicator__dot" />
      {status === "saving" ? "Saving…" : "Saved"}
    </span>
  );
}

// ── Publish status indicator ─────────────────────────────────────────────────

type PublishStatus = "idle" | "publishing" | "published" | "error";

function PublishIndicator({ status, error }: { status: PublishStatus; error?: string }) {
  if (status === "idle") return null;
  const label = status === "publishing" ? "Publishing…"
    : status === "published" ? "Published"
    : `Publish failed: ${error ?? "unknown error"}`;
  return (
    <span
      className={`context-publish-indicator context-publish-indicator--${status}`}
      title={status === "error" ? label : undefined}
    >
      <span className="context-publish-indicator__dot" />
      <span className="context-publish-indicator__label">{label}</span>
    </span>
  );
}

// ── Publish confirm view ─────────────────────────────────────────────────────
// Renders inline in the main content area (same slot HistoryDiffView uses) when
// the user clicks "Publish file" — shows a diff of last-published vs. current
// content before actually publishing, reusing DiffLines/diffLines rather than
// a new diff engine.

type PublishConfirmState =
  | { kind: "diff"; diffParts: Change[] }
  | { kind: "nothing-to-publish" }
  | { kind: "not-configured" };

function PublishConfirmView({
  state,
  onConfirm,
  onCancel,
}: {
  state: PublishConfirmState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const title = state.kind === "diff" ? "Publish preview"
    : state.kind === "nothing-to-publish" ? "Nothing to publish since last publish"
    : "Team collaboration not set up";

  return (
    <div className="context-content">
      <div className="context-content__toolbar">
        <div className="context-meta-strip">{title}</div>
        <div className="context-content__toolbar-right">
          {state.kind === "diff" && (
            <button className="context-content__publish-button" onClick={onConfirm}>
              Publish
            </button>
          )}
          <button className="context-content__history-toggle" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      <div className="context-content__scroll">
        {state.kind === "nothing-to-publish" ? (
          <p className="changelog-panel__empty">This file has no changes since it was last published.</p>
        ) : state.kind === "not-configured" ? (
          <p className="changelog-panel__empty">
            This profile isn't connected to a shared team repository yet. Run the{" "}
            <code>draft-setup-collab</code> skill inside your agent session to connect one before publishing.
          </p>
        ) : (
          <pre className="proposal-diff" aria-label="Publish diff">
            <DiffLines parts={state.diffParts} />
          </pre>
        )}
      </div>
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
  const { track } = useAnalytics();

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

  // ── Compact nudge dismissed dims (per-session) ────────────────────────────────
  const [dismissedDims, setDismissedDims] = useState<Set<string>>(new Set());

  // ── History sidebar ──────────────────────────────────────────────────────────
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // Clear the selected diff whenever the sidebar closes, so re-opening starts fresh.
  useEffect(() => {
    if (!historyOpen) setSelectedVersionId(null);
  }, [historyOpen]);

  // ── Sync state ───────────────────────────────────────────────────────────────
  const [localConfig, setLocalConfig] = useState<LocalConfig>({ teamLoadMode: "auto", launchOnLogin: false, notificationsEnabled: true, disabledContextSections: [], codexScanIntervalMinutes: 360, claudeCodeSynthesis: true, lastPublished: null });
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
        setSelectedPath((prev) => prev || (firstSelectable?.relativePath ?? result[0]?.relativePath ?? ""));
      }
    }).catch(() => setFiles([]));
  }

  // ── Sync a saved edit back into tree state ───────────────────────────────────
  // Without this, `files` stays frozen at whatever loadFiles() last returned. Switch
  // away from an edited file and back, and ContextEditor remounts with the stale
  // pre-edit body as initialContent — silently reverting the save on the next
  // autosave/blur. See plans/0025 write-path notes on ContextEditor.
  function handleFileSaved(relativePath: string, content: string, frontmatterRaw?: string) {
    setFiles((prev) => prev.map((f) => (
      f.relativePath === relativePath
        ? { ...f, content, ...(frontmatterRaw !== undefined ? { frontmatterRaw } : {}) }
        : f
    )));
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

  function handleSelectDoc(path: string) {
    setSelectedPath(path);
    setHistoryOpen(false);
    const entry = files.find((f) => f.relativePath === path);
    if (entry) {
      track("context_doc_viewed", { kind: entry.kind, group: entry.group });
    }
  }

  function toggleDim(group: string) {
    const expanding = !expandedDims.has(group);
    setExpandedDims((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
    if (expanding) track("context_doc_expanded", { group });
  }

  // ── Add dimension handler ─────────────────────────────────────────────────────
  async function handleAddDimension(name: string): Promise<{ ok: boolean; error?: string }> {
    const result = await rpc.request.addContextDimension({ name });
    if (result.ok) {
      track("context_dimension_added", {});
      loadFiles();
      setSelectedPath(`${name}/index.md`);
    }
    return result;
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
            onSelect={handleSelectDoc}
            onToggleDim={toggleDim}
            onToggleGroup={toggleGroup}
            onContextMenu={handleContextMenu}
            onAddDimension={handleAddDimension}
          />
          {selectedEntry && (
            selectedVersionId ? (
              <HistoryDiffView
                key={selectedEntry.relativePath}
                relativePath={selectedEntry.relativePath}
                selectedVersionId={selectedVersionId}
                onClose={() => setSelectedVersionId(null)}
              />
            ) : (
              <ContextContent
                key={selectedEntry.relativePath}
                entry={selectedEntry}
                isDismissed={dismissedDims.has(selectedEntry.group)}
                onDismiss={() => setDismissedDims((prev) => new Set(prev).add(selectedEntry.group))}
                historyOpen={historyOpen}
                onToggleHistory={() => setHistoryOpen((prev) => !prev)}
                onSaved={handleFileSaved}
              />
            )
          )}
          {historyOpen && selectedEntry && (
            <HistoryPanel
              relativePath={selectedEntry.relativePath}
              selectedVersionId={selectedVersionId}
              onSelectVersion={setSelectedVersionId}
              onClose={() => setHistoryOpen(false)}
            />
          )}
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
