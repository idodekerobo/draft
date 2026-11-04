import { useEffect, useState } from "react";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import { useFolderImport } from "../../../hooks/useFolderImport";

const dismissedKey = (workspaceId: string) => `draft.folderImportPromptDismissed.${workspaceId}`;

function readDismissed(workspaceId: string): boolean {
  try { return localStorage.getItem(dismissedKey(workspaceId)) === "1"; } catch { return false; }
}

/** For someone who finished onboarding on the web before the workspace had any context. Shown once, skippable. */
export function FolderImportPrompt({ workspaceId }: { workspaceId: string }) {
  const { track } = useAnalytics();
  const { error, importFolder } = useFolderImport();
  const [dismissed, setDismissed] = useState(() => readDismissed(workspaceId));

  useEffect(() => { setDismissed(readDismissed(workspaceId)); }, [workspaceId]);
  useEffect(() => { if (!dismissed) track("folder_import_prompt_viewed", {}); }, [dismissed]);

  function dismiss() {
    try { localStorage.setItem(dismissedKey(workspaceId), "1"); } catch {}
    setDismissed(true);
  }

  async function onImport() {
    if (await importFolder()) {
      track("folder_import_prompt_imported", {});
      dismiss();
    }
  }

  if (dismissed) return null;
  return (
    <aside className="folder-prompt" aria-label="Import a folder">
      <p className="folder-prompt__text">
        Give Draft something to read
        <small>Import a folder of docs from this computer to build your first context.</small>
      </p>
      <div className="folder-prompt__actions">
        <button type="button" className="ui-btn ui-btn--primary" onClick={() => void onImport()}>Import a folder</button>
        <button type="button" className="ui-link" onClick={() => { track("folder_import_prompt_skipped", {}); dismiss(); }}>Skip</button>
      </div>
      {error && <p className="folder-prompt__error" role="alert">{error}</p>}
    </aside>
  );
}
