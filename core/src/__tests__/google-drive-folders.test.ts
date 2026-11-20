import { describe, expect, test } from "bun:test";
import { folderOptionsFromBody, syncedFoldersFromBody } from "../integrations/google-drive-folders";

describe("google drive folder bodies", () => {
  test("maps synced folders and sync state", () => {
    expect(syncedFoldersFromBody({
      folders: [{ id: "r1", folder_kind: "shared_drive", google_folder_id: "d1", name: "Team" }],
      status: "active",
      last_success_at: "2026-11-20T10:00:00Z",
      reauth_required: false,
    })).toEqual({
      folders: [{ id: "r1", folderKind: "shared_drive", googleFolderId: "d1", name: "Team" }],
      status: "active",
      lastSuccessAt: "2026-11-20T10:00:00Z",
      reauthRequired: false,
    });
    expect(syncedFoldersFromBody(null)).toEqual({ folders: [], status: null, lastSuccessAt: null, reauthRequired: false });
  });

  test("maps options with who syncs them", () => {
    expect(folderOptionsFromBody({ options: [{ folder_kind: "folder", google_folder_id: "f1", name: "Plans", synced: true, synced_by_you: false, synced_by: "Bo" }] }))
      .toEqual([{ folderKind: "folder", googleFolderId: "f1", name: "Plans", synced: true, syncedByYou: false, syncedBy: "Bo" }]);
  });
});
