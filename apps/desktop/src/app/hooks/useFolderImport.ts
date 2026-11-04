import { useState } from "react";
import { DEFAULT_SETUP_DIMENSIONS, toDimensionHints } from "draft-shared-ui";
import { events, rpc } from "../rpc";

/** Picks a folder and starts the first context run from it. Resolves true when a run started. */
export function useFolderImport() {
  const [imported, setImported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function importFolder(): Promise<boolean> {
    setError(null);
    const picked = await rpc.request.selectUploadFolder();
    if (!picked.folderPath) return false;
    const result = await rpc.request.bootstrapWorkspaceContext({ folderPath: picked.folderPath, dimensions: toDimensionHints(DEFAULT_SETUP_DIMENSIONS) });
    if (result.ok && result.runId) {
      events.emit("bootstrapRunStarted", { runId: result.runId });
      setImported(true);
      return true;
    }
    setError(result.reason === "no_ready_items" ? "That folder has no files Draft can read. Choose a different one." : result.error ?? "Could not import that folder.");
    return false;
  }

  return { imported, error, importFolder };
}
