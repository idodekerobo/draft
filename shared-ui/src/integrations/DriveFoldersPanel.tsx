"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useIntegrationActions } from "./IntegrationActionsContext";
import type { DriveFolderOption, SyncedGoogleDriveFolder } from "../types";

export const DRIVE_FOLDER_CONSENT = "Every file in these folders goes into company context, including files only you can see.";

const DRIVE_ERROR_MESSAGES: Record<string, string> = {
  drive_not_connected: "Google Drive is not connected. Connect it first.",
  google_reconnect_required: "Google ended Draft's access. Reconnect Google Drive, then try again.",
  not_folder_owner: "Only the person who added this folder can remove it.",
};

export function driveErrorMessage(code: string | undefined, fallback: string): string {
  return (code && DRIVE_ERROR_MESSAGES[code]) || fallback;
}

export interface SyncedGoogleDriveFoldersState {
  status: "idle" | "loading" | "ready" | "error";
  folders: SyncedGoogleDriveFolder[];
  lastSuccessAt: string | null;
  reauthRequired: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Loads the caller's synced Google Drive folders while Drive is connected. The row status and the panel share it. */
export function useSyncedGoogleDriveFolders(enabled: boolean): SyncedGoogleDriveFoldersState {
  const { listSyncedGoogleDriveFolders } = useIntegrationActions();
  const [state, setState] = useState<Omit<SyncedGoogleDriveFoldersState, "reload">>({ status: "idle", folders: [], lastSuccessAt: null, reauthRequired: false, error: null });
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!enabled) {
      setState({ status: "idle", folders: [], lastSuccessAt: null, reauthRequired: false, error: null });
      return;
    }
    setState((previous) => ({ ...previous, status: previous.status === "ready" ? "ready" : "loading", error: null }));
    try {
      const result = await listSyncedGoogleDriveFolders();
      if (current !== generation.current) return;
      if (!result.ok) {
        setState((previous) => ({ ...previous, status: "error", error: driveErrorMessage(result.error, "Could not load your synced folders.") }));
        return;
      }
      setState({ status: "ready", folders: result.folders ?? [], lastSuccessAt: result.lastSuccessAt ?? null, reauthRequired: result.reauthRequired ?? false, error: null });
    } catch {
      if (current === generation.current) setState((previous) => ({ ...previous, status: "error", error: "Could not load your synced folders." }));
    }
  }, [enabled, listSyncedGoogleDriveFolders]);

  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}

function formatSyncTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function DriveFoldersPanel({ state }: { state: SyncedGoogleDriveFoldersState }) {
  const { removeSyncedGoogleDriveFolder, track } = useIntegrationActions();
  const [browsing, setBrowsing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<{ id: string; message: string } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const autoOpened = useRef(false);

  // A person who just connected Drive has nothing synced yet, so start with the folder browser open.
  useEffect(() => {
    if (state.status === "ready" && state.folders.length === 0 && !autoOpened.current) {
      autoOpened.current = true;
      setBrowsing(true);
    }
  }, [state.status, state.folders.length]);

  function closeBrowser() {
    setBrowsing(false);
    requestAnimationFrame(() => addRef.current?.focus());
  }

  async function remove(folder: SyncedGoogleDriveFolder) {
    setRemoving(folder.id);
    setRemoveError(null);
    try {
      const result = await removeSyncedGoogleDriveFolder({ id: folder.id });
      if (!result.ok) {
        setRemoveError({ id: folder.id, message: driveErrorMessage(result.error, "Could not remove this folder. Try again.") });
        return;
      }
      track("integration_channels_updated", { source: "google_drive" });
      await state.reload();
      requestAnimationFrame(() => addRef.current?.focus());
    } catch {
      setRemoveError({ id: folder.id, message: "Could not remove this folder. Try again." });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="ui-panel__connect-panel ui-drive">
      <span className="ui-panel__panel-label">Synced folders</span>
      <span className="ui-panel__panel-help">{DRIVE_FOLDER_CONSENT}</span>
      {state.reauthRequired && (
        <span className="ui-panel__validation" role="alert">Google ended Draft&apos;s access. Reconnect Google Drive to keep these folders in sync.</span>
      )}
      {(state.status === "loading" || state.status === "idle") && <p className="ui-panel__panel-help" role="status">Loading synced folders…</p>}
      {state.status === "error" && (
        <div className="ui-drive__notice">
          <span className="ui-panel__validation" role="alert">{state.error}</span>
          <button type="button" className="ui-btn" onClick={() => void state.reload()}>Try again</button>
        </div>
      )}
      {state.status === "ready" && state.folders.length === 0 && (
        <p className="ui-panel__panel-help" role="status">No synced folders yet. Add a folder or shared drive to start.</p>
      )}
      {state.status === "ready" && state.folders.length > 0 && (
        <>
          <ul className="ui-drive__list" aria-label="Synced folders">
            {state.folders.map((folder) => (
              <li key={folder.id} className="ui-drive__row">
                <span className="ui-drive__name">
                  <span>{folder.name}</span>
                  <small>{folder.folderKind === "shared_drive" ? "Shared drive" : "Folder"}</small>
                </span>
                <span className="ui-drive__action">
                  <button type="button" className="ui-btn" aria-label={`Remove ${folder.name}`} disabled={removing !== null} aria-busy={removing === folder.id} onClick={() => void remove(folder)}>
                    {removing === folder.id ? "Removing…" : "Remove"}
                  </button>
                </span>
                {removeError?.id === folder.id && <span className="ui-panel__validation ui-drive__row-error" role="alert">{removeError.message}</span>}
              </li>
            ))}
          </ul>
          <span className="ui-panel__panel-help">
            {state.lastSuccessAt ? <>Last synced <time dateTime={state.lastSuccessAt}>{formatSyncTime(state.lastSuccessAt)}</time></> : "Not synced yet. The first sync starts within a few minutes."}
          </span>
        </>
      )}
      {state.status === "ready" && (
        <button ref={addRef} type="button" className="ui-btn" aria-expanded={browsing} onClick={() => (browsing ? closeBrowser() : setBrowsing(true))}>
          {browsing ? "Done adding" : "Add folder"}
        </button>
      )}
      {browsing && <DriveFolderBrowser synced={state.folders} onAdded={state.reload} />}
    </div>
  );
}

interface Level {
  /** "top" lists shared drives, then My Drive folders. Otherwise a folder or shared drive id. */
  parent: string;
  name: string;
}

export function DriveFolderBrowser({ synced, onAdded }: { synced: SyncedGoogleDriveFolder[]; onAdded: () => Promise<void> }) {
  const { listDriveFolderOptions, addSyncedGoogleDriveFolder, track } = useIntegrationActions();
  const [path, setPath] = useState<Level[]>([{ parent: "top", name: "Google Drive" }]);
  const [options, setOptions] = useState<DriveFolderOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<{ id: string; message: string } | null>(null);
  const headingRef = useRef<HTMLSpanElement>(null);
  const level = path[path.length - 1]!;

  useEffect(() => {
    let cancelled = false;
    setOptions(null);
    setError(null);
    const parents = level.parent === "top" ? ["shared", "root"] : [level.parent];
    Promise.all(parents.map((parent) => listDriveFolderOptions({ parent })))
      .then((results) => {
        if (cancelled) return;
        const failed = results.find((result) => !result.ok);
        if (failed) {
          setError(driveErrorMessage(failed.error, "Could not load your Google Drive folders."));
          setOptions([]);
          return;
        }
        setOptions(results.flatMap((result) => result.options ?? []));
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not load your Google Drive folders.");
        setOptions([]);
      });
    return () => { cancelled = true; };
  }, [level.parent, attempt, listDriveFolderOptions]);

  function go(next: Level[]) {
    setAddError(null);
    setPath(next);
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function add(option: DriveFolderOption) {
    setAdding(option.googleFolderId);
    setAddError(null);
    try {
      const result = await addSyncedGoogleDriveFolder({ folderKind: option.folderKind, googleFolderId: option.googleFolderId, name: option.name });
      if (!result.ok) {
        setAddError({ id: option.googleFolderId, message: result.message ?? driveErrorMessage(result.error, "Could not add this folder. Try again.") });
        return;
      }
      track("integration_channels_updated", { source: "google_drive" });
      await onAdded();
    } catch {
      setAddError({ id: option.googleFolderId, message: "Could not add this folder. Try again." });
    } finally {
      setAdding(null);
    }
  }

  const syncedIds = new Set(synced.map((folder) => folder.googleFolderId));
  const sharedDrives = (options ?? []).filter((option) => option.folderKind === "shared_drive");
  const folders = (options ?? []).filter((option) => option.folderKind === "folder");
  const groups = level.parent === "top"
    ? [{ label: "Shared drives", items: sharedDrives }, { label: "My Drive", items: folders }]
    : [{ label: null, items: [...sharedDrives, ...folders] }];

  return (
    <section className="ui-drive__browser" aria-label="Add a folder">
      <div className="ui-drive__crumbs">
        {path.length > 1 && <button type="button" className="ui-link" onClick={() => go(path.slice(0, -1))}>Back</button>}
        <span ref={headingRef} tabIndex={-1} className="ui-drive__crumb-path">{path.map((step) => step.name).join(" / ")}</span>
      </div>
      {options === null && <p className="ui-panel__panel-help" role="status">Loading folders…</p>}
      {error && (
        <div className="ui-drive__notice">
          <span className="ui-panel__validation" role="alert">{error}</span>
          <button type="button" className="ui-btn" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </div>
      )}
      {options !== null && !error && options.length === 0 && (
        <p className="ui-panel__panel-help" role="status">{level.parent === "top" ? "No shared drives or folders found in your Google Drive." : "No folders inside this one."}</p>
      )}
      {options !== null && !error && options.length > 0 && groups.map(({ label, items }) => items.length > 0 && (
        <div key={label ?? "items"} className="ui-drive__group">
          {label && <span className="ui-drive__group-label">{label}</span>}
          <ul className="ui-drive__list">
            {items.map((option) => {
              const mine = option.syncedByYou || syncedIds.has(option.googleFolderId);
              const someoneElse = option.synced && !mine;
              return (
                <li key={option.googleFolderId} className="ui-drive__row">
                  <span className="ui-drive__name">
                    <button type="button" className="ui-drive__open" aria-label={`Open ${option.name}`} onClick={() => go([...path, { parent: option.googleFolderId, name: option.name }])}>
                      {option.name}
                    </button>
                    {someoneElse && <small>Already synced by {option.syncedBy ?? "a teammate"}</small>}
                  </span>
                  <span className="ui-drive__action">
                    {mine
                      ? <span className="ui-drive__synced">Synced</span>
                      : (
                        <button type="button" className="ui-btn" aria-label={someoneElse ? `${option.name} is already synced by ${option.syncedBy ?? "a teammate"}` : `Add ${option.name}`} disabled={someoneElse || adding !== null} aria-busy={adding === option.googleFolderId} onClick={() => void add(option)}>
                          {adding === option.googleFolderId ? "Adding…" : "Add"}
                        </button>
                      )}
                  </span>
                  {addError?.id === option.googleFolderId && <span className="ui-panel__validation ui-drive__row-error" role="alert">{addError.message}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
