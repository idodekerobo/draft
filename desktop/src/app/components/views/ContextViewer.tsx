// ContextViewer.tsx — two-panel context browser: tree left, rendered markdown right

import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import type { ContextFileEntry } from "../../../rpc/schema";
import { rpc } from "../../rpc";

marked.setOptions({ breaks: true });

// ── Empty state ───────────────────────────────────────────────────────────────

function ContextEmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">◎</div>
      <p className="empty-state__title">No context files yet</p>
      <p className="empty-state__body">
        Run /draft:setup in Claude Code to populate your workspace context.
      </p>
    </div>
  );
}

// ── Tree item ─────────────────────────────────────────────────────────────────

function TreeItem({
  entry,
  isActive,
  onSelect,
  extraClass,
}: {
  entry: ContextFileEntry;
  isActive: boolean;
  onSelect: () => void;
  extraClass?: string;
}) {
  return (
    <button
      className={`context-tree__item${isActive ? " context-tree__item--active" : ""}${extraClass ? ` ${extraClass}` : ""}`}
      onClick={onSelect}
      title={entry.label}
    >
      <span className="context-tree__item-label">{entry.label}</span>
    </button>
  );
}

// ── Dim row (expandable dimension with optional log children) ─────────────────

function DimRow({
  dim,
  logs,
  selectedPath,
  isExpanded,
  onToggle,
  onSelect,
}: {
  dim: ContextFileEntry;
  logs: ContextFileEntry[];
  selectedPath: string;
  isExpanded: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
}) {
  const hasLogs = logs.length > 0;

  return (
    <div className="context-dim-row">
      <div className={`context-dim-row__main${dim.relativePath === selectedPath ? " context-dim-row__main--active" : ""}`}>
        {/* Label area — select only */}
        <button
          className="context-dim-row__label"
          onClick={() => onSelect(dim.relativePath)}
          title={dim.label}
        >
          <span className="context-tree__item-label">{dim.label}</span>
        </button>

        {/* Expand arrow — toggle only, no selection */}
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
            title={log.label}
          >
            <span className="context-tree__item-label">· {log.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Group section (collapsible header + children) ─────────────────────────────

function GroupSection({
  groupId,
  groupLabel,
  children,
  selectedPath,
  isCollapsed,
  onToggle,
  onSelect,
}: {
  groupId: string;
  groupLabel: string;
  children: ContextFileEntry[];
  selectedPath: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
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
}: {
  files: ContextFileEntry[];
  selectedPath: string;
  expandedDims: Set<string>;
  collapsedGroups: Set<string>;
  onSelect: (path: string) => void;
  onToggleDim: (group: string) => void;
  onToggleGroup: (group: string) => void;
}) {
  const dims = files.filter((f) => f.kind === "dim");
  const standalones = files.filter((f) => f.kind === "standalone");

  // Collect groups (decisions, research, etc.)
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

  // Log entries keyed by dim group
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
        />
      ))}

      {standalones.map((entry) => (
        <TreeItem
          key={entry.relativePath}
          entry={entry}
          isActive={entry.relativePath === selectedPath}
          onSelect={() => onSelect(entry.relativePath)}
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

// ── Main component ────────────────────────────────────────────────────────────

interface ContextViewerProps {
  activeProfile: string;
}

export function ContextViewer({ activeProfile: _activeProfile }: ContextViewerProps) {
  const [files, setFiles] = useState<ContextFileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [expandedDims, setExpandedDims] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    rpc.request.getContextFiles().then((result) => {
      setFiles(result);
      if (result.length > 0) {
        const firstSelectable = result.find((f) => f.kind === "dim" || f.kind === "standalone" || f.kind === "group-child");
        setSelectedPath(firstSelectable?.relativePath ?? result[0].relativePath);
      }
    }).catch(() => {
      setFiles([]);
    });
  }, []);

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
      </div>
      <div className="context-viewer__body">
        <ContextTree
          files={files}
          selectedPath={selectedPath}
          expandedDims={expandedDims}
          collapsedGroups={collapsedGroups}
          onSelect={setSelectedPath}
          onToggleDim={toggleDim}
          onToggleGroup={toggleGroup}
        />
        {selectedEntry && <ContextContent entry={selectedEntry} />}
      </div>
    </div>
  );
}
