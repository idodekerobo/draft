import { describe, expect, it } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "123456";
process.env.GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG ?? "draft-test";
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY ?? "key";
process.env.GITHUB_APP_WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET ?? "secret";

const { DriveApiError } = await import("../../ingestion/google-drive/api");
const folders = await import("../../ingestion/google-drive/synced-folders");
const routes = await import("../../routes/google-drive-folders");
const { fakeClient, fakeDb } = await import("../routines/fake-client");
type DriveApi = import("../../ingestion/google-drive/api").DriveApi;
type DriveFile = import("../../ingestion/google-drive/api").DriveFile;

function seed() {
  return fakeDb(
    {
      connections: [
        { id: "conn-a", workspace_id: "ws-1", provider: "google_drive", connected_by_user_id: "user-a", display_name: "Ada", status: "active", last_success_at: null, cursor_json: {} },
        { id: "conn-b", workspace_id: "ws-1", provider: "google_drive", connected_by_user_id: "user-b", display_name: "Bo", status: "active", last_success_at: null, cursor_json: {} },
      ],
      synced_google_drive_folders: [],
      scheduled_tasks: [{ id: "task-a", workspace_id: "ws-1", task_type: "ingest_source", task_key: "conn-a", next_due_at: "2030-01-01T00:00:00.000Z" }],
    },
    { unique: { synced_google_drive_folders: [["workspace_id", "google_folder_id"]] } },
  );
}

function fakeApi(files: Record<string, DriveFile>, extra: Partial<DriveApi> = {}): DriveApi {
  return {
    getFile: async (id: string) => {
      const file = files[id];
      if (!file) throw new DriveApiError("missing", "not_found", 404);
      return file;
    },
    ...extra,
  } as unknown as DriveApi;
}

const deps = (db: ReturnType<typeof seed>, api: DriveApi = fakeApi({})) => ({
  db: fakeClient(db),
  driveAccess: (async () => ({ ok: true, api })) as unknown as typeof import("../../ingestion/google-drive/access").driveAccessFor,
  now: () => new Date("2026-11-20T00:00:00.000Z"),
});

describe("synced Google Drive folders", () => {
  it("refuses a folder another connection syncs and names its owner", async () => {
    const db = seed();
    const client = fakeClient(db);
    await folders.addSyncedGoogleDriveFolder(client, "ws-1", "conn-b", { folderKind: "folder", googleFolderId: "f-1", name: "Plans" });
    const result = await folders.addSyncedGoogleDriveFolder(client, "ws-1", "conn-a", { folderKind: "folder", googleFolderId: "f-1", name: "Plans" });
    expect(result).toMatchObject({ ok: false, code: "drive_folder_already_synced", message: "Already synced by Bo." });

    const response = await routes.addDriveFolder("ws-1", "user-a", { folderKind: "folder", googleFolderId: "f-1", name: "Plans" }, deps(db));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "drive_folder_already_synced", synced_by: "Bo" });
  });

  it("resolves an ID-only CLI add with the caller's Google login", async () => {
    const db = seed();
    const api = fakeApi({ "f-1": { id: "f-1", name: "Plans", mimeType: "application/vnd.google-apps.folder" }, "d-1": { id: "d-1", driveId: "d-1", name: "Team", mimeType: "application/vnd.google-apps.folder" }, "doc-1": { id: "doc-1", mimeType: "application/vnd.google-apps.document" } });
    const response = await routes.addDriveFolder("ws-1", "user-a", { googleFolderId: "f-1" }, deps(db, api));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ folder: { name: "Plans", folder_kind: "folder", google_folder_id: "f-1" } });
    const shared = await routes.addDriveFolder("ws-1", "user-a", { googleFolderId: "d-1" }, deps(db, api));
    expect(await shared.json()).toMatchObject({ folder: { folder_kind: "shared_drive" } });
    expect((await routes.addDriveFolder("ws-1", "user-a", { googleFolderId: "doc-1" }, deps(db, api))).status).toBe(400);
    expect((await routes.addDriveFolder("ws-1", "user-a", { googleFolderId: "missing" }, deps(db, api))).status).toBe(404);
  });

  it("allows a nested folder and leaves the sync cursor to the sync", async () => {
    const db = seed();
    const cursor = { backfill: { seen: 40, folders: { "f-child": { done: true }, "f-1": { done: true } } } };
    db.tables.connections![0]!.cursor_json = cursor;
    await routes.addDriveFolder("ws-1", "user-b", { folderKind: "folder", googleFolderId: "f-1", name: "Plans" }, deps(db));
    const response = await routes.addDriveFolder("ws-1", "user-a", { folderKind: "folder", googleFolderId: "f-child", name: "Q4" }, deps(db));
    expect(response.status).toBe(201);
    expect(db.tables.synced_google_drive_folders).toHaveLength(2);
    expect(db.tables.connections![0]!.cursor_json).toEqual(cursor);
    expect(db.tables.scheduled_tasks![0]!.next_due_at).toBe("2026-11-20T00:00:00.000Z");
  });

  it("maps Drive API failures to Draft's own codes", async () => {
    const db = seed();
    const failing = (code: "unauthorized" | "forbidden" | "not_found" | "request_failed", status: number) =>
      fakeApi({}, { getFile: async () => { throw new DriveApiError("x", code, status); }, listFolderChildren: async () => { throw new DriveApiError("x", code, status); } });
    const add = (api: DriveApi) => routes.addDriveFolder("ws-1", "user-a", { googleFolderId: "f-1" }, deps(db, api));
    const cases = [["unauthorized", 401, 409, "google_reconnect_required"], ["forbidden", 403, 403, "drive_folder_forbidden"], ["not_found", 404, 404, "not_found"], ["request_failed", 500, 502, "drive_folder_lookup_failed"]] as const;
    for (const [code, googleStatus, status, error] of cases) {
      const response = await add(failing(code, googleStatus));
      expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([status, error]);
    }
    const options = await routes.listDriveFolderOptions("ws-1", "user-a", "root", deps(db, failing("unauthorized", 401)));
    expect(options.status).toBe(409);
  });

  it("removes a folder only for its owner", async () => {
    const db = seed();
    await routes.addDriveFolder("ws-1", "user-a", { folderKind: "shared_drive", googleFolderId: "d-1", name: "Team" }, deps(db));
    const rowId = db.tables.synced_google_drive_folders![0]!.id as string;

    expect((await routes.removeDriveFolder("ws-1", "user-b", rowId, deps(db))).status).toBe(403);
    expect((await routes.removeDriveFolder("ws-1", "user-c", rowId, deps(db))).status).toBe(404);
    expect((await routes.removeDriveFolder("ws-1", "user-a", rowId, deps(db))).status).toBe(200);
    expect(db.tables.synced_google_drive_folders).toHaveLength(0);
    expect((await routes.removeDriveFolder("ws-1", "user-a", rowId, deps(db))).status).toBe(404);
  });

  it("lists the caller's synced folders", async () => {
    const db = seed();
    await routes.addDriveFolder("ws-1", "user-a", { folderKind: "folder", googleFolderId: "f-1", name: "Plans" }, deps(db));
    await routes.addDriveFolder("ws-1", "user-b", { folderKind: "folder", googleFolderId: "f-2", name: "Other" }, deps(db));
    const body = await (await routes.listDriveFolders("ws-1", "user-a", deps(db))).json() as { folders: unknown; status: string };
    expect(body.folders).toEqual([{ id: expect.any(String), folder_kind: "folder", google_folder_id: "f-1", name: "Plans" }]);
    expect(body.status).toBe("active");
  });

  it("marks options another person already syncs", async () => {
    const db = seed();
    await routes.addDriveFolder("ws-1", "user-b", { folderKind: "folder", googleFolderId: "f-1", name: "Plans" }, deps(db));
    const api = fakeApi({}, {
      listFolderChildren: async () => ({
        files: [
          { id: "f-1", name: "Plans", mimeType: "application/vnd.google-apps.folder" },
          { id: "f-2", name: "Notes", mimeType: "application/vnd.google-apps.folder" },
          { id: "doc-1", name: "Doc", mimeType: "application/vnd.google-apps.document" },
        ],
      }),
    });
    const body = await (await routes.listDriveFolderOptions("ws-1", "user-a", "root", deps(db, api))).json() as { options: unknown };
    expect(body.options).toEqual([
      { folder_kind: "folder", google_folder_id: "f-1", name: "Plans", synced: true, synced_by_you: false, synced_by: "Bo" },
      { folder_kind: "folder", google_folder_id: "f-2", name: "Notes", synced: false, synced_by_you: false, synced_by: null },
    ]);
  });
});

describe("createFolderResolver", () => {
  const synced = [
    { id: "s1", folderKind: "shared_drive" as const, googleFolderId: "drive-1", name: "Team", connectionId: "conn-a" },
    { id: "s2", folderKind: "folder" as const, googleFolderId: "f-top", name: "Top", connectionId: "conn-a" },
  ];
  const api = fakeApi({
    "f-mid": { id: "f-mid", name: "Mid", parents: ["f-top"] },
    "f-low": { id: "f-low", name: "Low", parents: ["f-mid"] },
    "f-out": { id: "f-out", name: "Out", parents: ["root"] },
    "d-sub": { id: "d-sub", name: "Sub", parents: ["drive-1"], driveId: "drive-1" },
  });

  it("matches a file in a synced shared drive", async () => {
    const resolver = folders.createFolderResolver(api, synced);
    expect(await resolver.match({ id: "x", driveId: "drive-1", parents: ["d-sub"] })).toMatchObject({ folder: { id: "s1" }, path: ["Sub"] });
  });

  it("matches a file nested under a synced folder", async () => {
    const resolver = folders.createFolderResolver(api, synced);
    expect(await resolver.match({ id: "x", parents: ["f-low"] })).toMatchObject({ folder: { id: "s2" }, path: ["Mid", "Low"] });
  });

  it("does not match a file outside every synced folder", async () => {
    const resolver = folders.createFolderResolver(api, synced);
    expect(await resolver.contains({ id: "x", parents: ["f-out"] })).toBe(false);
    expect(await resolver.contains({ id: "y", driveId: "drive-2", parents: ["drive-2"] })).toBe(false);
  });

  it("workspaceContains ignores folders of revoked connections", async () => {
    const db = seed();
    const client = fakeClient(db);
    await folders.addSyncedGoogleDriveFolder(client, "ws-1", "conn-b", { folderKind: "folder", googleFolderId: "f-top", name: "Top" });
    expect(await folders.workspaceContains(client, "ws-1", api, { id: "x", parents: ["f-mid"] })).toBe(true);
    db.tables.connections![1]!.status = "revoked";
    expect(await folders.workspaceContains(client, "ws-1", api, { id: "x", parents: ["f-mid"] })).toBe(false);
  });
});
