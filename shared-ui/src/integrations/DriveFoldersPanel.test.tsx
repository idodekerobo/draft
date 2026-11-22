import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntegrationActionsProvider } from "./IntegrationActionsContext";
import { DRIVE_FOLDER_CONSENT, DriveFoldersPanel, useSyncedGoogleDriveFolders } from "./DriveFoldersPanel";
import type { DriveFolderOptionsResult, IntegrationActions, SyncedGoogleDriveFoldersResult } from "../types";

afterEach(cleanup);

function actions(overrides: Partial<IntegrationActions>): IntegrationActions {
  return {
    track: () => {},
    openUrl: () => {},
    listSyncedGoogleDriveFolders: async () => ({ ok: true, folders: [], lastSuccessAt: null }),
    listDriveFolderOptions: async () => ({ ok: true, options: [] }),
    addSyncedGoogleDriveFolder: async () => ({ ok: true }),
    removeSyncedGoogleDriveFolder: async () => ({ ok: true }),
    ...overrides,
  } as IntegrationActions;
}

function Harness() {
  const state = useSyncedGoogleDriveFolders(true);
  return <DriveFoldersPanel state={state} />;
}

function renderPanel(overrides: Partial<IntegrationActions>) {
  return render(<IntegrationActionsProvider actions={actions(overrides)}><Harness /></IntegrationActionsProvider>);
}

const plans = { id: "row-1", folderKind: "folder" as const, googleFolderId: "f-1", name: "Plans" };

describe("DriveFoldersPanel", () => {
  it("lists synced folders with the consent line and last sync time", async () => {
    renderPanel({ listSyncedGoogleDriveFolders: async () => ({ ok: true, folders: [plans], lastSuccessAt: "2026-11-20T15:04:00Z" }) });
    expect(await screen.findByText("Plans")).toBeTruthy();
    expect(screen.getByText(DRIVE_FOLDER_CONSENT)).toBeTruthy();
    expect(screen.getByText(/Last synced/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Plans" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Add a folder" })).toBeNull();
  });

  it("shows an error with a retry when the list fails", async () => {
    let calls = 0;
    renderPanel({ listSyncedGoogleDriveFolders: async (): Promise<SyncedGoogleDriveFoldersResult> => (++calls === 1 ? { ok: false, error: "x" } : { ok: true, folders: [plans] }) });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load your synced folders.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Plans")).toBeTruthy();
  });

  it("opens the browser when nothing is synced, with shared drives first and a teammate's folder disabled", async () => {
    const listDriveFolderOptions = mock(async ({ parent }: { parent: string }): Promise<DriveFolderOptionsResult> => parent === "shared"
      ? { ok: true, options: [{ folderKind: "shared_drive", googleFolderId: "d-1", name: "Team drive", synced: false, syncedByYou: false, syncedBy: null }] }
      : { ok: true, options: [{ folderKind: "folder", googleFolderId: "f-2", name: "Roadmap", synced: true, syncedByYou: false, syncedBy: "Bo" }] });
    renderPanel({ listDriveFolderOptions });
    expect(await screen.findByText("No synced folders yet. Add a folder or shared drive to start.")).toBeTruthy();
    expect(await screen.findByText("Team drive")).toBeTruthy();
    const labels = screen.getAllByText(/^(Shared drives|My Drive)$/).map((node) => node.textContent);
    expect(labels).toEqual(["Shared drives", "My Drive"]);
    expect(screen.getByText("Already synced by Bo")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Roadmap is already synced by Bo" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add Team drive" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("adds a folder and shows the server's refusal beside the row", async () => {
    const add = mock(async () => ({ ok: false, error: "drive_folder_already_synced", message: "Already synced by Bo." }));
    renderPanel({
      listDriveFolderOptions: async ({ parent }) => ({ ok: true, options: parent === "root" ? [{ folderKind: "folder", googleFolderId: "f-3", name: "Notes", synced: false, syncedByYou: false, syncedBy: null }] : [] }),
      addSyncedGoogleDriveFolder: add,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add Notes" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Already synced by Bo.");
    expect(add).toHaveBeenCalledWith({ folderKind: "folder", googleFolderId: "f-3", name: "Notes" });
  });

  it("opens a folder, shows its empty state, and goes back", async () => {
    renderPanel({
      listDriveFolderOptions: async ({ parent }) => ({ ok: true, options: parent === "root" ? [{ folderKind: "folder", googleFolderId: "f-4", name: "Archive", synced: false, syncedByYou: false, syncedBy: null }] : [] }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open Archive" }));
    expect(await screen.findByText("No folders inside this one.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Open Archive" })).toBeTruthy();
  });

  it("shows a load error in the browser", async () => {
    renderPanel({ listDriveFolderOptions: async () => ({ ok: false, error: "google_reconnect_required" }) });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Reconnect Google Drive"));
  });

  it("removes a folder and reloads the list", async () => {
    let folders = [plans];
    const remove = mock(async () => { folders = []; return { ok: true }; });
    renderPanel({ listSyncedGoogleDriveFolders: async () => ({ ok: true, folders }), removeSyncedGoogleDriveFolder: remove });
    fireEvent.click(await screen.findByRole("button", { name: "Remove Plans" }));
    await waitFor(() => expect(screen.queryByText("Plans")).toBeNull());
    expect(remove).toHaveBeenCalledWith({ id: "row-1" });
  });
});

describe("Google Drive row", () => {
  it("shows Edit, not Connect, while folders still need choosing", async () => {
    const { ToolList } = await import("./ToolList");
    render(<ToolList platform="web" statuses={{ "google-drive": { state: "pending", detail: "Choose folders", linked: true } }} agentPrompt="" agentLastUsedAt={null} mcpUrl="" panels={{ "google-drive": () => null }} managePanels={{ "google-drive": { label: "Edit", render: () => null } }} />);
    expect(screen.getByText("Choose folders")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });
});
