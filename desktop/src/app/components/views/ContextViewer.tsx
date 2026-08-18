// ContextViewer.tsx — context file browser
//
// Layout: context-viewer__body — file tree (left) + markdown content (right)

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import type {
  ContextFileEntry,
  SessionPreview,
} from "../../../rpc/schema";
import { rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { ContextEditor, RawEditor } from "./ContextEditor";

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
}: {
  entry: ContextFileEntry;
}) {
  const { name, last_updated, source } = parseFrontmatterFields(entry.frontmatterRaw);
  const hasMeta = name || last_updated || source;
  const containerRef = useRef<HTMLDivElement>(null);
  const [rawOpen, setRawOpen] = useState(false);

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

  const metaParts = [
    name,
    last_updated ? `updated ${last_updated}` : undefined,
    source ? `source: ${source}` : undefined,
  ].filter(Boolean) as string[];

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
          <button
            className={`context-content__history-toggle${rawOpen ? " context-content__history-toggle--active" : ""}`}
            onClick={() => setRawOpen((prev) => !prev)}
          >
            {rawOpen ? "View rendered" : "View raw"}
          </button>
          <ToolbarMenu
            items={[
              { label: rawOpen ? "View rendered" : "View raw", onClick: () => setRawOpen((prev) => !prev), active: rawOpen },
            ]}
          />
        </div>
      </div>
      <div className="context-content__scroll">
        {rawOpen ? (
          <RawEditor
            key={entry.relativePath}
            relativePath={entry.relativePath}
            initialRawContent={entry.frontmatterRaw + entry.content}
          />
        ) : (
          <ContextEditor
            key={entry.relativePath}
            relativePath={entry.relativePath}
            initialContent={entry.content}
          />
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
  files: ContextFileEntry[];
  setFiles: Dispatch<SetStateAction<ContextFileEntry[]>>;
  reloadFiles: () => Promise<void>;
  loading: boolean;
}

export function ContextViewer({ activeProfile, files, setFiles, reloadFiles, loading }: ContextViewerProps) {
  const { track } = useAnalytics();

  // ── File tree state ──────────────────────────────────────────────────────────
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [expandedDims, setExpandedDims] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // ── View mode + session preview ──────────────────────────────────────────────
  const [mode, setMode] = useState<"browse" | "session">("browse");
  const [sessionPreview, setSessionPreview] = useState<SessionPreview | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);

  // ── Context menu ─────────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

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

  // Reconcile selection whenever the shared snapshot changes. This covers first
  // load, removals, profile switches, and explicit reloads after mutations.
  useEffect(() => {
    setSelectedPath((previous) => {
      if (files.some((file) => file.relativePath === previous)) return previous;
      const firstSelectable = files.find(
        (file) => file.kind === "dim" || file.kind === "standalone" || file.kind === "group-child",
      );
      return firstSelectable?.relativePath ?? files[0]?.relativePath ?? "";
    });
  }, [files]);

  function handleSelectDoc(path: string) {
    setSelectedPath(path);
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

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const selectedEntry = files.find((f) => f.relativePath === selectedPath) ?? null;

  if (loading && files.length === 0) {
    return <div className="empty-state">Loading context…</div>;
  }

  if (files.length === 0) {
    return (
      <div className="context-viewer">
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
          />
          {selectedEntry && (
            <ContextContent
              key={selectedEntry.relativePath}
              entry={selectedEntry}
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
