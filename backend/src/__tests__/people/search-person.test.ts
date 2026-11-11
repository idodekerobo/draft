import { describe, expect, it } from "bun:test";
import { searchSources } from "../../services/sources";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const UZO_USER = "44444444-4444-4444-8444-444444444444";
const UZO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IZA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CALLER = UZO_USER;

const row = (id: string) => ({
  source_item_id: id, source_version: "v1", title: "Standup", provider: "slack", item_type: "message", representation_kind: "source",
  occurred_at: "2026-11-09T10:00:00Z", source_time_start: null, source_time_end: null, metadata_json: {}, content_markdown: "text",
  sanitized_raw_json: null, agent_session_id: null, excerpt: "text", rank: 0,
});

function setup(rows: unknown[] = [row("s1")]) {
  const db = fakeDb(
    {
      people: [
        { id: UZO, workspace_id: WS, user_id: UZO_USER },
        { id: IZA, workspace_id: WS, user_id: null },
      ],
      person_identities: [
        { workspace_id: WS, person_id: UZO, provider: "email", external_id: "uzo@example.com", status: "confirmed" },
        { workspace_id: WS, person_id: UZO, provider: "slack", external_id: "U0UZO1234", status: "from_connection" },
        { workspace_id: WS, person_id: UZO, provider: "slack", external_id: "UGUESS", status: "inferred" },
        { workspace_id: WS, person_id: IZA, provider: "email", external_id: "iza@example.com", status: "inferred" },
      ],
    },
    { rpcs: { search_sources: () => ({ data: rows }) } },
  );
  return { db, client: fakeClient(db) };
}

describe("searchSources with a person", () => {
  it("resolves me to the caller's person and sends only their trusted ids to the search", async () => {
    const { db, client } = setup();
    const result = await searchSources(client, WS, CALLER, { person: "me" });
    expect(result.ok).toBe(true);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_query: null, p_person_terms: ["uzo@example.com", "U0UZO1234"] });
  });

  it("resolves a person id, and passes the query along as well", async () => {
    const { db, client } = setup();
    await searchSources(client, WS, CALLER, { person: UZO, query: "action items" });
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_query: "action items", p_person_terms: ["uzo@example.com", "U0UZO1234"] });
  });

  it("returns nothing, without searching, for a person with no trusted id", async () => {
    const { db, client } = setup();
    const result = await searchSources(client, WS, CALLER, { person: IZA });
    expect(result).toMatchObject({ ok: true, value: { results: [], next_cursor: null } });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("refuses a person who is not in the workspace", async () => {
    const { client } = setup();
    expect(await searchSources(client, WS, CALLER, { person: "99999999-9999-4999-8999-999999999999" })).toMatchObject({ ok: false, error: { code: "invalid_filter" } });
    expect(await searchSources(client, "00000000-0000-4000-8000-000000000000", CALLER, { person: "me" })).toMatchObject({ ok: false });
  });

  it("needs a query or a person", async () => {
    const { client } = setup();
    expect(await searchSources(client, WS, CALLER, {})).toMatchObject({ ok: false, error: { code: "invalid_query" } });
    expect(await searchSources(client, WS, CALLER, { query: "   " })).toMatchObject({ ok: false, error: { code: "invalid_query" } });
  });

  it("does not let a cursor from one person's search be used for another's", async () => {
    const many = Array.from({ length: 3 }, (_, i) => row(`s${i}`));
    const { client } = setup(many);
    const first = await searchSources(client, WS, CALLER, { person: UZO, limit: 2 });
    expect(first.ok && first.value.next_cursor).toBeTruthy();
    const cursor = first.ok ? first.value.next_cursor! : "";
    expect(await searchSources(client, WS, CALLER, { person: "me", limit: 2, cursor })).toMatchObject({ ok: false, error: { code: "cursor_mismatch" } });
    expect((await searchSources(client, WS, CALLER, { person: UZO, limit: 2, cursor })).ok).toBe(true);
  });

  it("leaves a plain query search as it was", async () => {
    const { db, client } = setup();
    await searchSources(client, WS, CALLER, { query: "roadmap" });
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_query: "roadmap", p_person_terms: null });
  });
});
