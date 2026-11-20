import { beforeEach, describe, expect, it } from "bun:test";

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? "https://supabase.example.test";
process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? "publishable-key";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "service-key";
process.env.INFERENCE_CREDENTIAL_KEK_V1 ??= Buffer.alloc(32, 7).toString("base64");
process.env.INFERENCE_CREDENTIAL_KEK_V2 ??= Buffer.alloc(32, 7).toString("base64");

const { encryptCredentialPayload, CURRENT_CREDENTIAL_KEY_VERSION } = await import("../../credentials/crypto");
const { DriveApiError, DOC_MIME, FOLDER_MIME } = await import("../../ingestion/google-drive/api");
const { GoogleOAuthError } = await import("../../ingestion/google/oauth");
const sync = await import("../../ingestion/google-drive/sync");
const { fakeClient, fakeDb } = await import("../routines/fake-client");
type DriveApi = import("../../ingestion/google-drive/api").DriveApi;
type DriveFile = import("../../ingestion/google-drive/api").DriveFile;
type DriveChange = import("../../ingestion/google-drive/api").DriveChange;
type DriveComment = import("../../ingestion/google-drive/comments").DriveComment;
type Row = Record<string, unknown>;

const NOW = new Date("2026-11-20T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const settings = { clientId: "c", clientSecret: "s", redirectUri: "https://api.test/cb" };

function credential(id: string) {
  return {
    id,
    workspace_id: "ws-1",
    provider: "google",
    status: "active",
    expires_at: null,
    encrypted_payload: encryptCredentialPayload(JSON.stringify({ refresh_token: `refresh-${id}`, scopes: [] }), CURRENT_CREDENTIAL_KEY_VERSION),
    encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
  };
}

function connection(id: string, userId: string, extra: Row = {}): Row {
  return { id, workspace_id: "ws-1", provider: "google_drive", connected_by_user_id: userId, credential_id: `cred-${id}`, status: "active", cursor_json: {}, last_success_at: null, ...extra };
}

// Mirrors write_drive_source_item and delete_drive_file across every google_drive connection.
function seed(connections: Row[] = [connection("conn-a", "user-a")]) {
  const db = fakeDb(
    {
      connections,
      credentials: connections.map((row) => credential(`cred-${row.id}`)),
      synced_google_drive_folders: [],
      source_items: [],
    },
    {
      rpcs: {
        write_drive_source_item: (args) => {
          const items = db.tables.source_items!;
          const sameFile = items.filter((row) => row.external_id === args.p_external_id && row.lifecycle_status === "active");
          const existing = sameFile.find((row) => row.external_version === args.p_external_version);
          if (existing) return { data: { item_id: existing.id, changed: false, superseded_item_ids: [] } };
          const id = `item-${items.length + 1}`;
          for (const row of sameFile) row.lifecycle_status = "superseded";
          items.push({
            id,
            workspace_id: args.p_workspace_id,
            connection_id: args.p_connection_id,
            external_id: args.p_external_id,
            external_version: args.p_external_version,
            lifecycle_status: "active",
            occurred_at: args.p_occurred_at,
            content_markdown: args.p_content_markdown,
            sanitized_raw_json: args.p_sanitized_raw_json,
            metadata_json: args.p_metadata_json,
            owner_user_id: args.p_owner_user_id,
            visibility: args.p_visibility,
            supersedes_source_item_id: sameFile[0]?.id ?? null,
          });
          return { data: { item_id: id, changed: true, superseded_item_ids: sameFile.map((row) => row.id) } };
        },
        delete_drive_file: (args) => {
          const rows = db.tables.source_items!.filter((row) => row.external_id === args.p_external_id);
          for (const row of rows) Object.assign(row, { lifecycle_status: "deleted", content_markdown: null, sanitized_raw_json: null });
          return { data: rows.length };
        },
      },
    },
  );
  return db;
}

function addFolder(db: ReturnType<typeof seed>, connectionId: string, googleFolderId: string, folderKind = "folder") {
  db.tables.synced_google_drive_folders!.push({ id: `sf-${googleFolderId}`, workspace_id: "ws-1", connection_id: connectionId, folder_kind: folderKind, google_folder_id: googleFolderId, name: googleFolderId.toUpperCase() });
}

interface FakeFile extends DriveFile {
  text?: string;
  comments?: DriveComment[];
}

class FakeDrive {
  files = new Map<string, FakeFile>();
  changePages: Array<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }> = [];
  changeTokens: string[] = [];
  forbidden = new Set<string>();
  getDocumentCalls = 0;

  add(file: FakeFile) {
    this.files.set(file.id, { mimeType: DOC_MIME, modifiedTime: daysAgo(1), text: `text of ${file.id}`, ...file });
  }

  api(): DriveApi {
    const drive = this;
    return {
      getStartPageToken: async () => "start-1",
      listFiles: async ({ driveId, pageToken }) => {
        const all = [...drive.files.values()].filter((file) => file.driveId === driveId && file.mimeType !== FOLDER_MIME && (file.modifiedTime ?? "") > daysAgo(90));
        const offset = pageToken ? Number(pageToken) : 0;
        const files = all.slice(offset, offset + 100);
        return { files, nextPageToken: offset + 100 < all.length ? String(offset + 100) : undefined };
      },
      listFolderChildren: async (folderId, pageToken) => {
        const all = [...drive.files.values()].filter((file) => file.parents?.[0] === folderId);
        const offset = pageToken ? Number(pageToken) : 0;
        const files = all.slice(offset, offset + 100);
        return { files, nextPageToken: offset + 100 < all.length ? String(offset + 100) : undefined };
      },
      listChanges: async (token) => {
        drive.changeTokens.push(token);
        return drive.changePages.shift() ?? { changes: [], newStartPageToken: token };
      },
      getFile: async (id) => {
        const file = drive.files.get(id);
        if (!file) throw new DriveApiError("missing", "not_found", 404);
        return file;
      },
      listSharedDrives: async () => [],
      listComments: async (id) => drive.files.get(id)?.comments ?? [],
      getDocument: async (id) => {
        drive.getDocumentCalls += 1;
        if (drive.forbidden.has(id)) throw new DriveApiError("no", "forbidden", 403);
        const file = drive.files.get(id);
        if (!file) throw new DriveApiError("missing", "not_found", 404);
        return { title: file.name, body: { content: [{ paragraph: { elements: [{ textRun: { content: `${file.text}\n` } }] } }] } } as never;
      },
      getSpreadsheet: async () => ({}) as never,
      getSheetValues: async () => [],
      getPresentation: async () => ({}) as never,
    };
  }
}

function deps(drives: Record<string, FakeDrive>, skips: string[] = [], refresh?: () => Promise<{ accessToken: string }>) {
  return {
    settings: () => settings,
    refreshAccessToken: (async (_settings: unknown, refreshToken: string) => (refresh ? refresh() : { accessToken: refreshToken.replace("refresh-cred-", "") })) as never,
    createApi: (accessToken: string) => drives[accessToken]!.api(),
    now: () => NOW,
    recordSkip: (_connection: unknown, fileId: string, reason: string) => skips.push(`${fileId}:${reason}`),
  };
}

const run = (db: ReturnType<typeof seed>, id: string, drives: Record<string, FakeDrive>, skips?: string[]) =>
  sync.syncDriveConnection({ id, workspace_id: "ws-1" }, fakeClient(db), deps(drives, skips));

const active = (db: ReturnType<typeof seed>) => db.tables.source_items!.filter((row) => row.lifecycle_status === "active");

describe("syncDriveConnection", () => {
  beforeEach(() => sync.resetSheetThrottle());

  it("backfills a synced folder breadth first within 90 days and writes shared items owned by the connector", async () => {
    const db = seed();
    addFolder(db, "conn-a", "f-1");
    const drive = new FakeDrive();
    drive.add({ id: "sub", name: "Sub", mimeType: FOLDER_MIME, parents: ["f-1"] });
    drive.add({ id: "doc-1", name: "Plan", parents: ["f-1"] });
    drive.add({ id: "doc-2", name: "Deep", parents: ["sub"] });
    drive.add({ id: "doc-old", parents: ["f-1"], modifiedTime: daysAgo(120) });
    drive.add({ id: "doc-out", parents: ["elsewhere"] });

    await run(db, "conn-a", { "conn-a": drive });

    expect(active(db).map((row) => row.external_id).sort()).toEqual(["doc-1", "doc-2"]);
    const deep = active(db).find((row) => row.external_id === "doc-2")!;
    expect(deep).toMatchObject({ owner_user_id: "user-a", visibility: "shared" });
    expect(deep.metadata_json).toMatchObject({ title: "Deep", folder_path: "F-1/Sub", file_id: "doc-2" });
    const call = db.rpcCalls.find((entry) => entry.name === "write_drive_source_item")!.args;
    expect(call).toMatchObject({ p_item_type: "document", p_representation_kind: "source", p_visibility: "shared" });
    expect(db.tables.connections![0]).toMatchObject({ status: "active", last_success_at: NOW.toISOString() });
    expect(db.tables.connections![0]!.cursor_json).toMatchObject({ start_page_token: "start-1", backfill: { seen: 2, folders: { "f-1": { done: true } } } });
  });

  it("caps the backfill at 500 files and spreads it across polls", async () => {
    const db = seed();
    addFolder(db, "conn-a", "drive-1", "shared_drive");
    const drive = new FakeDrive();
    for (let i = 0; i < 620; i += 1) drive.add({ id: `d-${String(i).padStart(3, "0")}`, driveId: "drive-1", parents: ["drive-1"] });

    await run(db, "conn-a", { "conn-a": drive });
    expect(active(db)).toHaveLength(100);
    for (let poll = 0; poll < 6; poll += 1) await run(db, "conn-a", { "conn-a": drive });
    expect(active(db)).toHaveLength(500);
    expect(db.tables.connections![0]!.cursor_json).toMatchObject({ backfill: { seen: 500, folders: { "drive-1": { done: true } } } });
  });

  it("follows change pages, writes a new version on edit or comment, and nothing when unchanged", async () => {
    const db = seed([connection("conn-a", "user-a", { cursor_json: { start_page_token: "t-1", backfill: { seen: 0, folders: { "f-1": { done: true } } } } })]);
    addFolder(db, "conn-a", "f-1");
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-1"] });
    drive.changePages = [
      { changes: [{ fileId: "doc-1", file: drive.files.get("doc-1") }], nextPageToken: "t-2" },
      { changes: [], newStartPageToken: "t-3" },
    ];
    await run(db, "conn-a", { "conn-a": drive });
    expect(drive.changeTokens).toEqual(["t-1", "t-2"]);
    expect(db.tables.connections![0]!.cursor_json).toMatchObject({ start_page_token: "t-3" });
    expect(db.tables.source_items).toHaveLength(1);

    drive.changePages = [{ changes: [{ fileId: "doc-1", file: drive.files.get("doc-1") }], newStartPageToken: "t-4" }];
    await run(db, "conn-a", { "conn-a": drive });
    expect(db.tables.source_items).toHaveLength(1);

    drive.files.get("doc-1")!.text = "edited";
    drive.changePages = [{ changes: [{ fileId: "doc-1", file: drive.files.get("doc-1") }], newStartPageToken: "t-5" }];
    await run(db, "conn-a", { "conn-a": drive });
    expect(db.tables.source_items).toHaveLength(2);

    drive.files.get("doc-1")!.comments = [{ author: { displayName: "Ana" }, content: "Ship it" }];
    drive.changePages = [{ changes: [{ fileId: "doc-1", file: drive.files.get("doc-1") }], newStartPageToken: "t-6" }];
    await run(db, "conn-a", { "conn-a": drive });
    expect(db.tables.source_items).toHaveLength(3);
    expect(active(db)).toHaveLength(1);
    expect(active(db)[0]!.content_markdown).toContain("Ana: Ship it");
  });

  it("soft-deletes every version of a trashed file", async () => {
    const db = seed([connection("conn-a", "user-a", { cursor_json: { start_page_token: "t-1", backfill: { seen: 0, folders: { "f-1": { done: true } } } } })]);
    addFolder(db, "conn-a", "f-1");
    db.tables.source_items!.push(
      { id: "old", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-1", external_version: "v1", lifecycle_status: "superseded", content_markdown: "old" },
      { id: "new", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-1", external_version: "v2", lifecycle_status: "active", content_markdown: "new" },
    );
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-1"], trashed: true });
    drive.changePages = [{ changes: [{ fileId: "doc-1", file: drive.files.get("doc-1") }], newStartPageToken: "t-2" }];

    await run(db, "conn-a", { "conn-a": drive });

    expect(db.tables.source_items!.map((row) => [row.lifecycle_status, row.content_markdown])).toEqual([["deleted", null], ["deleted", null]]);
  });

  it("keeps a file moved out of this person's folder when another connection's synced folder holds it", async () => {
    const db = seed([
      connection("conn-a", "user-a", { cursor_json: { start_page_token: "t-1", backfill: { seen: 0, folders: { "f-1": { done: true } } } } }),
      connection("conn-b", "user-b"),
    ]);
    addFolder(db, "conn-a", "f-1");
    addFolder(db, "conn-b", "f-2");
    db.tables.source_items!.push({ id: "item-x", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-1", external_version: "v1", lifecycle_status: "active", content_markdown: "x" });
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-2"] });
    drive.add({ id: "doc-2", parents: ["nowhere"] });
    drive.add({ id: "nowhere", mimeType: FOLDER_MIME });
    db.tables.source_items!.push({ id: "item-y", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-2", external_version: "v1", lifecycle_status: "active", content_markdown: "y" });
    drive.changePages = [{
      changes: [
        { fileId: "doc-1", file: drive.files.get("doc-1") },
        { fileId: "doc-2", file: drive.files.get("doc-2") },
      ],
      newStartPageToken: "t-2",
    }];

    await run(db, "conn-a", { "conn-a": drive });

    expect(db.tables.source_items!.find((row) => row.id === "item-x")!.lifecycle_status).toBe("active");
    expect(db.tables.source_items!.find((row) => row.id === "item-y")!.lifecycle_status).toBe("deleted");
  });

  it("keeps a file another live connection captured, or that may sit under a teammate's folder this login cannot read", async () => {
    const db = seed([
      connection("conn-a", "user-a", { cursor_json: { start_page_token: "t-1", backfill: { seen: 0, folders: { "f-1": { done: true } } } } }),
      connection("conn-b", "user-b"),
    ]);
    addFolder(db, "conn-a", "f-1");
    addFolder(db, "conn-b", "f-2");
    db.tables.source_items!.push(
      { id: "b-old", workspace_id: "ws-1", connection_id: "conn-b", external_id: "doc-1", external_version: "v0", lifecycle_status: "superseded", content_markdown: "b" },
      { id: "a-new", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-1", external_version: "v1", lifecycle_status: "active", content_markdown: "a" },
      { id: "a-hidden", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-2", external_version: "v1", lifecycle_status: "active", content_markdown: "h" },
    );
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["somewhere"] });
    drive.add({ id: "somewhere", mimeType: FOLDER_MIME });
    // doc-2's parent folder is not visible to user-a, so the walk toward f-2 stops there.
    drive.add({ id: "doc-2", parents: ["hidden-sub"] });
    drive.changePages = [{ changes: [{ fileId: "doc-1", file: drive.files.get("doc-1") }, { fileId: "doc-2", file: drive.files.get("doc-2") }], newStartPageToken: "t-2" }];

    await run(db, "conn-a", { "conn-a": drive });

    expect(db.tables.source_items!.find((row) => row.id === "a-new")!.lifecycle_status).toBe("active");
    expect(db.tables.source_items!.find((row) => row.id === "a-hidden")!.lifecycle_status).toBe("active");
  });

  it("cleans old unchanged files after folder removal, across bounded polls, and keeps another synced folder's files", async () => {
    const db = seed([
      connection("conn-a", "user-a", { cursor_json: { start_page_token: "t-1", backfill: { seen: 0, folders: { "f-1": { done: true } } } } }),
      connection("conn-b", "user-b"),
    ]);
    addFolder(db, "conn-b", "f-2");
    const drive = new FakeDrive();
    drive.add({ id: "f-1", mimeType: FOLDER_MIME });
    for (let index = 0; index < 105; index++) {
      const id = `doc-${String(index).padStart(3, "0")}`;
      drive.add({ id, parents: [index === 0 ? "f-2" : "f-1"], modifiedTime: "2020-01-01T00:00:00Z" });
      db.tables.source_items!.push({ id: `item-${String(index).padStart(3, "0")}`, workspace_id: "ws-1", connection_id: "conn-a", external_id: id, lifecycle_status: "active", content_markdown: "stored" });
    }
    db.tables.source_items!.push({ id: "old-version", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-001", lifecycle_status: "superseded", content_markdown: "older" });
    await run(db, "conn-a", { "conn-a": drive });
    expect(db.tables.source_items!.filter((row) => row.lifecycle_status === "active")).toHaveLength(6);
    expect(db.tables.connections![0]!.cursor_json).toMatchObject({ folder_cleanup_after: "item-099" });
    await run(db, "conn-a", { "conn-a": drive });
    expect(db.tables.source_items!.filter((row) => row.lifecycle_status === "active").map((row) => row.external_id)).toEqual(["doc-000"]);
    expect(db.tables.source_items!.find((row) => row.id === "old-version")).toMatchObject({ lifecycle_status: "deleted", content_markdown: null });
    expect(db.tables.connections![0]!.cursor_json).not.toHaveProperty("folder_cleanup_after");
  });

  it("keeps one active row when the same file is in two connections' synced folders", async () => {
    const db = seed([connection("conn-a", "user-a"), connection("conn-b", "user-b")]);
    addFolder(db, "conn-a", "f-1");
    addFolder(db, "conn-b", "f-1-child");
    const drive = new FakeDrive();
    drive.add({ id: "f-1-child", mimeType: FOLDER_MIME, name: "Child", parents: ["f-1"] });
    drive.add({ id: "doc-1", parents: ["f-1-child"] });

    await run(db, "conn-a", { "conn-a": drive, "conn-b": drive });
    await run(db, "conn-b", { "conn-a": drive, "conn-b": drive });

    expect(active(db)).toHaveLength(1);
    expect(db.tables.source_items).toHaveLength(1);
  });

  it("supersedes rows written under another connection when a re-added folder writes a new version", async () => {
    const db = seed([connection("conn-a", "user-a", { status: "revoked" }), connection("conn-b", "user-b")]);
    db.tables.source_items!.push({ id: "old", workspace_id: "ws-1", connection_id: "conn-a", external_id: "doc-1", external_version: "stale", lifecycle_status: "active", content_markdown: "stale" });
    addFolder(db, "conn-b", "f-1");
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-1"] });

    await run(db, "conn-b", { "conn-b": drive });

    expect(db.tables.source_items!.find((row) => row.id === "old")!.lifecycle_status).toBe("superseded");
    expect(active(db)).toEqual([expect.objectContaining({ connection_id: "conn-b", supersedes_source_item_id: "old" })]);
  });

  it("marks the connection degraded on invalid_grant and stops polling until reconnect", async () => {
    const db = seed();
    addFolder(db, "conn-a", "f-1");
    const failing = async () => {
      throw new GoogleOAuthError("expired", "invalid_grant");
    };
    await sync.syncDriveConnection({ id: "conn-a", workspace_id: "ws-1" }, fakeClient(db), deps({}, [], failing));
    expect(db.tables.connections![0]).toMatchObject({ status: "degraded", cursor_json: { reauth_required: true } });

    let refreshed = 0;
    await sync.syncDriveConnection({ id: "conn-a", workspace_id: "ws-1" }, fakeClient(db), deps({}, [], async () => {
      refreshed += 1;
      return { accessToken: "x" };
    }));
    expect(refreshed).toBe(0);
  });

  it("leaves a connection revoked when it is disconnected during a poll", async () => {
    const db = seed();
    addFolder(db, "conn-a", "f-1");
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-1"] });
    const api = drive.api();
    const revoking = { ...api, getStartPageToken: async () => {
      db.tables.connections![0]!.status = "revoked";
      return api.getStartPageToken();
    } };
    await sync.syncDriveConnection({ id: "conn-a", workspace_id: "ws-1" }, fakeClient(db), { ...deps({ "conn-a": drive }), createApi: () => revoking });
    expect(db.tables.connections![0]!.status).toBe("revoked");

    db.tables.connections![0]!.status = "active";
    await sync.syncDriveConnection({ id: "conn-a", workspace_id: "ws-1" }, fakeClient(db), deps({}, [], async () => {
      db.tables.connections![0]!.status = "revoked";
      throw new GoogleOAuthError("expired", "invalid_grant");
    }));
    expect(db.tables.connections![0]!.status).toBe("revoked");
  });

  it("skips a folder it may not list, keeps backfilling the others and saves the cursor", async () => {
    const db = seed();
    addFolder(db, "conn-a", "f-gone");
    addFolder(db, "conn-a", "f-1");
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-1"] });
    const api = drive.api();
    const listing = { ...api, listFolderChildren: async (folderId: string, pageToken?: string) => {
      if (folderId === "f-gone") throw new DriveApiError("no", "not_found", 404);
      return api.listFolderChildren(folderId, pageToken);
    } };
    const skips: string[] = [];
    await sync.syncDriveConnection({ id: "conn-a", workspace_id: "ws-1" }, fakeClient(db), { ...deps({ "conn-a": drive }, skips), createApi: () => listing });

    expect(skips).toEqual(["f-gone:folder_unreadable"]);
    expect(active(db).map((row) => row.external_id)).toEqual(["doc-1"]);
    expect(db.tables.connections![0]!.cursor_json).toMatchObject({ start_page_token: "start-1", backfill: { folders: { "f-gone": { done: true }, "f-1": { done: true } } } });
  });

  it("starts a new or re-added folder's backfill with a fresh file budget", async () => {
    const db = seed([connection("conn-a", "user-a", { cursor_json: { start_page_token: "t-1", backfill: { seen: 500, folders: { "f-1": { done: true, synced_folder_id: "old-row" } } } } })]);
    addFolder(db, "conn-a", "f-1");
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-1"] });

    await run(db, "conn-a", { "conn-a": drive });

    expect(active(db).map((row) => row.external_id)).toEqual(["doc-1"]);
    expect(db.tables.connections![0]!.cursor_json).toMatchObject({ backfill: { seen: 1, folders: { "f-1": { done: true, synced_folder_id: "sf-f-1" } } } });
  });

  it("skips a file it may not read and keeps going", async () => {
    const db = seed();
    addFolder(db, "conn-a", "f-1");
    const drive = new FakeDrive();
    drive.add({ id: "doc-1", parents: ["f-1"] });
    drive.add({ id: "doc-2", parents: ["f-1"] });
    drive.forbidden.add("doc-1");
    const skips: string[] = [];

    await run(db, "conn-a", { "conn-a": drive }, skips);

    expect(skips).toEqual(["doc-1:forbidden"]);
    expect(active(db).map((row) => row.external_id)).toEqual(["doc-2"]);
    expect(db.tables.connections![0]!.status).toBe("active");
  });
});
