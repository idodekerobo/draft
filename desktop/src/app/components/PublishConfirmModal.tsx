// desktop/src/app/components/PublishConfirmModal.tsx
//
// Confirmation dialog for "Publish to Team" in Settings. Lists every context
// file with an unpublished change (from history.db, via getUnpublishedContextPaths)
// grouped by dimension, then runs a full publish (publishAllContext) on confirm.

import { useEffect, useState } from "react";
import { rpc } from "../rpc";

interface PublishConfirmModalProps {
  onClose: () => void;
  onPublished: (fileCount: number) => void;
}

type Phase = "loading" | "empty" | "ready" | "publishing" | "error";

interface FileGroup {
  dimension: string;
  paths: string[];
}

function groupLabel(segment: string): string {
  return segment.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupPaths(paths: string[]): FileGroup[] {
  const byDim = new Map<string, string[]>();
  for (const path of paths) {
    const dim = path.split("/")[0] ?? path;
    const list = byDim.get(dim) ?? [];
    list.push(path);
    byDim.set(dim, list);
  }
  return [...byDim.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dimension, list]) => ({ dimension, paths: list.sort() }));
}

export function PublishConfirmModal({ onClose, onPublished }: PublishConfirmModalProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [fileCount, setFileCount] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    rpc.request.getUnpublishedContextPaths()
      .then((paths) => {
        setFileCount(paths.length);
        setGroups(groupPaths(paths));
        setPhase(paths.length === 0 ? "empty" : "ready");
      })
      .catch(() => {
        setError("Could not read local changes.");
        setPhase("error");
      });
  }, []);

  async function handleConfirm() {
    setPhase("publishing");
    setError(undefined);
    try {
      const result = await rpc.request.publishAllContext();
      if (!result.ok) {
        setError(result.error ?? "Publish failed.");
        setPhase("error");
        return;
      }
      onPublished(result.files.length);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed.");
      setPhase("error");
    }
  }

  function handleEscape(e: React.KeyboardEvent) {
    if (e.key === "Escape" && phase !== "publishing") onClose();
  }

  return (
    <div
      className="publish-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-modal-title"
      onKeyDown={handleEscape}
      onClick={(e) => { if (e.target === e.currentTarget && phase !== "publishing") onClose(); }}
    >
      <div className="publish-modal">
        <div className="publish-modal__header">
          <p className="publish-modal__title" id="publish-modal-title">Publish to team</p>
          <p className="publish-modal__subtitle">
            {phase === "loading" ? "Checking for changes…"
              : phase === "empty" ? "Nothing to publish"
              : phase === "error" ? "Publish failed"
              : `${fileCount} ${fileCount === 1 ? "file" : "files"} will be pushed to the shared repository`}
          </p>
        </div>

        <div className="publish-modal__body">
          {phase === "loading" && (
            <div className="publish-modal__status">
              <span className="publish-modal__spinner" />
              Reading local history…
            </div>
          )}

          {phase === "empty" && (
            <p className="publish-modal__empty">
              Your local context already matches the last publish. Edit a file to create something to publish.
            </p>
          )}

          {phase === "error" && (
            <p className="publish-modal__error-text">{error}</p>
          )}

          {(phase === "ready" || phase === "publishing") && (
            <ul className="publish-file-list">
              {groups.map((group) => (
                <li key={group.dimension} className="publish-file-group">
                  <span className="publish-file-group__label">{groupLabel(group.dimension)}</span>
                  <ul className="publish-file-group__files">
                    {group.paths.map((path) => (
                      <li key={path} className="publish-file-row">
                        <span className="publish-file-row__dot" />
                        <span className="publish-file-row__path">{path}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="publish-modal__actions">
          {(phase === "ready" || phase === "error") && (
            <button
              className="publish-modal__btn publish-modal__btn--primary"
              onClick={() => void handleConfirm()}
            >
              {phase === "error" ? "Try Again" : `Publish ${fileCount} ${fileCount === 1 ? "file" : "files"}`}
            </button>
          )}
          {phase === "publishing" && (
            <button className="publish-modal__btn publish-modal__btn--primary" disabled>
              Publishing…
            </button>
          )}
          <button
            className="publish-modal__btn publish-modal__btn--ghost"
            onClick={onClose}
            disabled={phase === "publishing"}
          >
            {phase === "empty" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
