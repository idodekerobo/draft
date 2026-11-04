import { useState } from "react";
import { SettingsRow } from "draft-shared-ui";
import { useFolderImport } from "../../hooks/useFolderImport";

/** Settings entry for importing a folder of docs, so it stays reachable after onboarding. */
export function ImportFolderRow() {
  const { error, importFolder } = useFolderImport();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  async function onImport() {
    setBusy(true);
    setStarted(false);
    try {
      setStarted(await importFolder());
    } finally {
      setBusy(false);
    }
  }

  const helper = error
    ? <span className="ui-error" role="alert">{error}</span>
    : started
      ? "Import started. Your context updates when Draft finishes reading."
      : "Choose a folder of docs on this computer for Draft to read.";

  return (
    <li>
      <SettingsRow
        label="Import from a folder"
        helper={helper}
        control={<button type="button" className="settings__action-button" onClick={() => void onImport()} disabled={busy}>{busy ? "Importing…" : "Choose folder"}</button>}
      />
    </li>
  );
}
