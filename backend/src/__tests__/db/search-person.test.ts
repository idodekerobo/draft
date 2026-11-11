import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

// The person filter of search_sources: ids as whole words, in the text or the metadata, inside the usual
// visibility rules, with or without a query. The service that builds the ids is tested in the backend.
const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("search by person", "person-search");

async function addItem(workspaceId: string, connectionId: string, content: string, metadata: object = {}, occurredAt = new Date()): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex");
  const [row] = await db()<[{ id: string }]>`
    insert into source_items (workspace_id, source_connection_id, item_type, external_id, external_version, lifecycle_status, occurred_at, content_markdown, content_hash, metadata_json, visibility)
    values (${workspaceId}, ${connectionId}, 'message', ${randomUUID()}, 'v1', 'active', ${occurredAt}, ${content}, ${hash}, ${JSON.stringify(metadata)}::jsonb, 'shared')
    returning id
  `;
  return row.id;
}

async function search(workspaceId: string, args: { query?: string | null; terms?: string[] | null }): Promise<string[]> {
  const rows = await db()<Array<{ source_item_id: string }>>`
    select source_item_id from search_sources(
      p_workspace_id => ${workspaceId}::uuid,
      p_caller_user_id => ${randomUUID()}::uuid,
      p_query => ${args.query ?? null},
      p_person_terms => ${args.terms ? db().array(args.terms, "text") : null}::text[]
    )
  `;
  return rows.map((row) => row.source_item_id);
}

async function setup() {
  const { workspaceId } = await createWorkspace();
  const [connection] = await db()<[{ id: string }]>`
    insert into source_connections (workspace_id, provider, connection_key, status) values (${workspaceId}, 'slack', ${randomUUID()}, 'active') returning id
  `;
  return { workspaceId, connectionId: connection.id };
}

describeWithDatabase("search_sources by person", () => {
  test("finds items that mention an id in the text, and in the metadata", async () => {
    const { workspaceId, connectionId } = await setup();
    const inText = await addItem(workspaceId, connectionId, "Ping <@U0UZO1234> about the demo");
    const inMetadata = await addItem(workspaceId, connectionId, "Standup notes", { attendee_emails: ["uzo@example.com"] });
    await addItem(workspaceId, connectionId, "Ping <@U0IZA5678> about the demo");

    expect(await search(workspaceId, { terms: ["U0UZO1234"] })).toEqual([inText]);
    expect(await search(workspaceId, { terms: ["uzo@example.com"] })).toEqual([inMetadata]);
    expect((await search(workspaceId, { terms: ["U0UZO1234", "uzo@example.com"] })).sort()).toEqual([inText, inMetadata].sort());
  });

  test("matches whole words only, ignoring case, and treats regex characters as plain text", async () => {
    const { workspaceId, connectionId } = await setup();
    const hit = await addItem(workspaceId, connectionId, "Sent to Uzo@Example.com yesterday");
    await addItem(workspaceId, connectionId, "Sent to uzo@example.community yesterday");
    await addItem(workspaceId, connectionId, "Sent to uzoXexample.com yesterday");

    expect(await search(workspaceId, { terms: ["uzo@example.com"] })).toEqual([hit]);
  });

  test("lists a person's items newest first when there is no query, and narrows by query when there is one", async () => {
    const { workspaceId, connectionId } = await setup();
    const older = await addItem(workspaceId, connectionId, "U0UZO1234 owns the pricing page", {}, new Date("2026-11-01T10:00:00Z"));
    const newer = await addItem(workspaceId, connectionId, "U0UZO1234 owns the launch email", {}, new Date("2026-11-05T10:00:00Z"));

    expect(await search(workspaceId, { terms: ["U0UZO1234"] })).toEqual([newer, older]);
    expect(await search(workspaceId, { terms: ["U0UZO1234"], query: "pricing" })).toEqual([older]);
  });

  test("does not find another workspace's items, and a plain query search is unchanged", async () => {
    const mine = await setup();
    const theirs = await setup();
    const own = await addItem(mine.workspaceId, mine.connectionId, "U0UZO1234 owns the demo and the roadmap");
    await addItem(theirs.workspaceId, theirs.connectionId, "U0UZO1234 owns the demo and the roadmap");

    expect(await search(mine.workspaceId, { terms: ["U0UZO1234"] })).toEqual([own]);
    expect(await search(mine.workspaceId, { query: "roadmap" })).toEqual([own]);
  });

  test("the old argument list still resolves to the one function", async () => {
    const { workspaceId, connectionId } = await setup();
    const id = await addItem(workspaceId, connectionId, "the quarterly roadmap review");
    const rows = await db()<Array<{ source_item_id: string }>>`select source_item_id from search_sources(${workspaceId}::uuid, ${randomUUID()}::uuid, 'roadmap')`;
    expect(rows.map((row) => row.source_item_id)).toEqual([id]);
    const [count] = await db()<[{ n: string }]>`select count(*)::text as n from pg_proc where proname = 'search_sources'`;
    expect(count.n).toBe("1");
  });
});
