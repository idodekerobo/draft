// HistoryPanel.tsx — per-file version list, backed by history.db.
// Selecting a version reports its id up to ContextViewer, which renders the
// diff inline in the main content area (see HistoryDiffView).

import { Fragment, useEffect, useState } from "react";
import type { Change } from "diff";
import type { ContextFileVersion } from "../../../rpc/schema";
import { rpc } from "../../rpc";

export function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function sourceLabel(source: ContextFileVersion["source"]): string {
  if (source === "team-load") return "Team load";
  if (source === "initial") return "Initial";
  return "Edited";
}

export function DiffLines({ parts }: { parts: Change[] }) {
  return (
    <>
      {parts.map((part, index) => {
        const className = part.added
          ? "history-diff__line history-diff__line--added"
          : part.removed
            ? "history-diff__line history-diff__line--removed"
            : "history-diff__line";
        const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
        const lines = part.value.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        return lines.map((line, i) => (
          <div key={`${index}-${i}`} className={className}>{prefix}{line}</div>
        ));
      })}
    </>
  );
}

interface HistoryPanelProps {
  relativePath: string;
  selectedVersionId: string | null;
  onSelectVersion: (id: string | null) => void;
  onClose: () => void;
}

export function HistoryPanel({ relativePath, selectedVersionId, onSelectVersion, onClose }: HistoryPanelProps) {
  const [versions, setVersions] = useState<ContextFileVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onSelectVersion(null);
    rpc.request.getFileHistory({ relativePath }).then((result) => {
      if (!cancelled) {
        setVersions(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relativePath]);

  function toggleSelect(id: string) {
    onSelectVersion(selectedVersionId === id ? null : id);
  }

  // versions is ordered newest-first (created_at DESC), so the first entry with
  // publishedAt set is the version that was live at the most recent publish.
  const lastPublishedIndex = versions.findIndex((v) => v.publishedAt);

  return (
    <div className="history-panel">
      <div className="history-panel__header">
        <span className="history-panel__title">History</span>
        <button className="history-panel__close" onClick={onClose} aria-label="Close history">✕</button>
      </div>
      {loading ? (
        <div className="history-panel__loading">Loading…</div>
      ) : versions.length === 0 ? (
        <div className="history-panel__empty">No history yet for this file.</div>
      ) : (
        <ul className="history-panel__list">
          {versions.map((v, i) => (
            <Fragment key={v.id}>
              {/* versions is newest-first, so the first entry with publishedAt is the most
                  recent one live at the last publish — mark it as the team's current baseline. */}
              {i === lastPublishedIndex && (
                <li className="history-panel__divider">
                  <span className="history-panel__divider-line" />
                  <span className="history-panel__divider-label">
                    Published to team · {relativeTime(v.publishedAt as string)}
                  </span>
                  <span className="history-panel__divider-line" />
                </li>
              )}
              <li
                className={`history-panel__item${selectedVersionId === v.id ? " history-panel__item--selected" : ""}${i === lastPublishedIndex ? " history-panel__item--published-marker" : ""}`}
                onClick={() => toggleSelect(v.id)}
              >
                <span className="history-panel__item-time">{relativeTime(v.createdAt)}</span>
                <span className={`history-panel__badge history-panel__badge--${v.source}`}>{sourceLabel(v.source)}</span>
                {v.author && <span className="history-panel__item-author">{v.author}</span>}
                {v.publishedAt && <span className="history-panel__pill">Published</span>}
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
