import { describe, expect, it, mock } from "bun:test";
import { runDriveFolders, type DriveFoldersDeps } from "../integrations/providers/drive.ts";
import { integrationsSubcommandHelp } from "../integrations/help.ts";

function harness() {
  const lines: string[] = [];
  const deps: DriveFoldersDeps = {
    list: mock(async () => ({ ok: true as const, value: { status: "active", last_success_at: "2026-11-20T07:00:00Z", folders: [{ id: "row-1", folder_kind: "folder", google_folder_id: "folder-1", name: "Plans" }] } })),
    add: mock(async () => ({ ok: true as const, value: { folder: { id: "row-1" } } })),
    remove: mock(async () => ({ ok: true as const, value: { ok: true } })),
    stdout: (text) => { lines.push(text); },
  };
  return { deps, lines };
}

describe("Drive folder commands", () => {
  it("lists synced folders and last sync with a stable JSON envelope", async () => {
    const { deps, lines } = harness();
    expect(await runDriveFolders(["status", "--json"], deps)).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema_version: 1, status: "drive_folders", connectionStatus: "active", folders: [{ id: "row-1", googleFolderId: "folder-1", name: "Plans" }], lastSuccessAt: "2026-11-20T07:00:00Z" });
  });
  it("adds a Google folder ID and removes the stored folder ID", async () => {
    const { deps, lines } = harness();
    expect(await runDriveFolders(["folders", "add", "folder-1", "--json"], deps)).toBe(0);
    expect(deps.add).toHaveBeenCalledWith("folder-1");
    expect(JSON.parse(lines[0]!).status).toBe("folder_added");
    expect(await runDriveFolders(["folders", "remove", "row-1"], deps)).toBe(0);
    expect(deps.remove).toHaveBeenCalledWith("row-1");
  });
  it("rejects malformed mutations before making a request", async () => {
    const { deps } = harness();
    for (const args of [["folders", "add"], ["folders", "remove", "id", "extra"], ["status", "--json", "--json"]]) expect(await runDriveFolders(args, deps)).toBe(2);
    expect(deps.add).not.toHaveBeenCalled();
    expect(deps.remove).not.toHaveBeenCalled();
  });
  it("reports reconnection errors with a command the user can run", async () => {
    const { deps, lines } = harness();
    deps.list = async () => ({ ok: false, code: "google_reconnect_required" });
    expect(await runDriveFolders(["folders", "list", "--json"], deps)).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ code: "google_reconnect_required", action: "draft connections connect google" });
  });
  it("documents ID-based add and remove", () => {
    expect(integrationsSubcommandHelp("drive")).toContain("folders add <folder-or-shared-drive-id>");
    expect(integrationsSubcommandHelp("drive")).toContain("files only you can see");
  });
});

const { createMockBackend } = await import("./helpers/mock-backend.ts");
const { makeHome, runCli, seedCliAuth } = await import("./helpers/cli-runner.ts");

describe("Drive folder CLI transport", () => {
  it("routes list, add and remove through the authenticated workspace API", async () => {
    const backend = createMockBackend();
    const home = makeHome();
    seedCliAuth(home);
    backend.state.driveFoldersResponse = (method) => Response.json(method === "GET"
      ? { status: "active", folders: [{ id: "row-1", folder_kind: "folder", google_folder_id: "f-1", name: "Plans" }], last_success_at: null }
      : { ok: true });
    try {
      for (const words of [["folders", "list"], ["folders", "add", "f-1"], ["folders", "remove", "row-1"]]) {
        const result = await runCli(["connections", "drive", ...words, "--json"], { home, apiUrl: backend.url });
        expect(result.exitCode).toBe(0);
      }
      const calls = backend.state.requests.filter((req) => req.url.includes("/google/drive-folders"));
      expect(calls.map((req) => [req.method, new URL(req.url).pathname])).toEqual([
        ["GET", "/workspaces/ws-1/google/drive-folders"], ["POST", "/workspaces/ws-1/google/drive-folders"], ["DELETE", "/workspaces/ws-1/google/drive-folders/row-1"],
      ]);
      expect(JSON.parse(calls[1]!.body)).toEqual({ googleFolderId: "f-1" });
      expect(calls.every((req) => req.headers.authorization === "Bearer seed-at")).toBe(true);
    } finally { backend.stop(); }
  });
});
