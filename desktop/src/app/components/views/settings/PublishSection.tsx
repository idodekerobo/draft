// desktop/src/app/components/views/settings/PublishSection.tsx
//
// "Publish to team" row in Settings — full-workspace publish (paths omitted =
// context/, skills/, config/mcp.json), gated behind a confirm modal that
// lists exactly which files carry unpublished changes.

import { useEffect, useState } from "react";
import { rpc } from "../../../rpc";
import { PublishConfirmModal } from "../../PublishConfirmModal";

interface PublishSectionProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export function PublishSection({ onError, onNotice }: PublishSectionProps) {
  const [collabConfigured, setCollabConfigured] = useState<boolean | null>(null);
  const [lastPublished, setLastPublished] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  async function refresh() {
    try {
      const [collab, config, paths] = await Promise.all([
        rpc.request.getCollabConfigured(),
        rpc.request.getLocalConfig(),
        rpc.request.getUnpublishedContextPaths(),
      ]);
      setCollabConfigured(collab.configured);
      setLastPublished(config.lastPublished);
      setPendingCount(paths.length);
    } catch {
      setCollabConfigured(false);
      onError("Could not load publish status.");
    }
  }

  useEffect(() => { void refresh(); }, []);

  function handlePublished(fileCount: number) {
    onNotice(`Published ${fileCount} ${fileCount === 1 ? "file" : "files"} to the team repository.`);
    void refresh();
  }

  return (
    <section className="settings__section">
      <h2 className="settings__section-label">Team Publishing</h2>
      <div className="settings__rows">
        <div className="settings__row">
          <div className="settings__row-content">
            <span className="settings__row-label">Publish to team</span>
            {collabConfigured === false ? (
              <span className="settings__row-desc">
                Not connected — run <code className="app-row__code">draft-setup-collab</code> to connect a shared repository.
              </span>
            ) : (
              <span className="settings__row-desc">
                {pendingCount > 0
                  ? `${pendingCount} unpublished ${pendingCount === 1 ? "change" : "changes"} · last published ${relativeTime(lastPublished)}`
                  : `Up to date · last published ${relativeTime(lastPublished)}`}
              </span>
            )}
          </div>
          <button
            className="app-row__connect"
            onClick={() => setModalOpen(true)}
            disabled={collabConfigured === false || collabConfigured === null}
          >
            Publish
          </button>
        </div>
      </div>

      {modalOpen && (
        <PublishConfirmModal
          onClose={() => setModalOpen(false)}
          onPublished={handlePublished}
        />
      )}
    </section>
  );
}
