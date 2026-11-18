import { describe, expect, it } from "bun:test";
import { readSource } from "../../../services/sources";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const SHARED = "22222222-2222-4222-8222-222222222222";
const PRIVATE = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";

const source = (id: string, visibility: string) => ({
  id, workspace_id: WS, external_version: "v1", item_type: "document", representation_kind: "document",
  occurred_at: "2026-11-11T09:00:00.000Z", source_time_start: null, source_time_end: null,
  metadata_json: { title: "Team note" }, content_markdown: "Team note body", sanitized_raw_json: null,
  captured_session_id: null, lifecycle_status: "active", visibility, owner_user_id: OWNER,
  connections: { provider: "notion" },
});

describe("shared source access for runs", () => {
  it("lets a run read a shared item and hides an owner's private item", async () => {
    const client = fakeClient(fakeDb({ source_items: [source(SHARED, "shared"), source(PRIVATE, "private")] }));
    const shared = await readSource(client, WS, null, { source_item_id: SHARED });
    expect(shared).toMatchObject({ ok: true, value: { content: "Team note body" } });
    const privateItem = await readSource(client, WS, null, { source_item_id: PRIVATE });
    expect(privateItem).toMatchObject({ ok: false, error: { code: "source_not_found" } });
  });
});
