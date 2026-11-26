// One commit call of PgStorage: the check state of all its batches read up front (CommitState), each batch checked in memory
// against what the batches before it left, and the accepted batches written per table (PendingWrites). The checks and the
// net-effect logic are pi-durable's own SQLite implementation, kept the same; only the statements are Postgres.
import type { PoolClient } from "pg";
import type { DocumentContent, DocumentCreate, DocumentId, DocumentRecord, Id, Seq, StorageWrite } from "@earendil-works/pi-durable";
import { addressColumnsKey, addressKey, addressParts, type Cell, encodeIndexedString, encodeJson, isCurrentOnly, parseRecord } from "./pg-rows";

export type TableName = "conversation" | "entry" | "task" | "submission" | "document";

export type DocumentAction = {
  create?: DocumentCreate;
  copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
  content?: DocumentContent;
  retire: boolean;
};

export const claimOf = (write: StorageWrite): { readonly id: Id<string>; readonly table: TableName } | undefined => {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return { id: write.value.id, table: write.type };
    case "document.create":
    case "document.copy":
      return { id: write.record.id, table: "document" };
    case "document.change":
    case "document.retire":
      return undefined;
  }
};

/** One batch's writes per document; throws when a document gets two content commands or two retirements. */
export function prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
  const actions = new Map<DocumentId, DocumentAction>();
  for (const write of writes) {
    if (write.type !== "document.create" && write.type !== "document.copy" && write.type !== "document.change" && write.type !== "document.retire") continue;
    const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
    let action = actions.get(id);
    if (action === undefined) {
      action = { retire: false };
      actions.set(id, action);
    }
    switch (write.type) {
      case "document.create":
        if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
        action.create = write.record;
        action.content = write.content;
        break;
      case "document.copy":
        if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
        action.create = write.record;
        action.copy = write.source;
        break;
      case "document.change":
        if (action.content !== undefined || action.copy !== undefined) throw new Error(`Document ${id} has more than one content command`);
        action.content = write.content;
        break;
      case "document.retire":
        if (action.retire) throw new Error(`Document ${id} is retired more than once`);
        action.retire = true;
        break;
    }
  }
  return actions;
}

type Query = Pick<PoolClient, "query">;
const rowsOf = async <T>(client: Query, sql: string, params: unknown[]): Promise<T[]> => (await client.query(sql, params)).rows as T[];

/** What the checks of one call's batches read, advanced in memory by each accepted batch. */
export class CommitState {
  readonly #recordIds: Map<number, TableName>;
  readonly #documents: Map<number, DocumentRecord>;
  readonly #versions: Map<number, number>;
  readonly #current: Map<string, DocumentId | undefined>;

  private constructor(recordIds: Map<number, TableName>, documents: Map<number, DocumentRecord>, versions: Map<number, number>, current: Map<string, DocumentId | undefined>) {
    this.#recordIds = recordIds;
    this.#documents = documents;
    this.#versions = versions;
    this.#current = current;
  }

  static async read(client: Query, sessionId: string, batches: readonly (readonly StorageWrite[])[]): Promise<CommitState> {
    const ids = new Set<number>();
    const documentIds = new Set<number>();
    const deltaIds = new Set<number>();
    const addresses = new Map<string, ReturnType<typeof addressParts>>();
    for (const writes of batches) {
      for (const write of writes) {
        const claim = claimOf(write);
        if (claim !== undefined) ids.add(claim.id);
        switch (write.type) {
          case "document.create":
          case "document.copy":
            documentIds.add(write.record.id);
            addresses.set(addressKey(write.record), addressParts(write.record));
            break;
          case "document.change":
            documentIds.add(write.id);
            if (write.content.kind === "delta") deltaIds.add(write.id);
            break;
          case "document.retire":
            documentIds.add(write.id);
            break;
          default:
            break;
        }
      }
    }
    const recordIds = new Map<number, TableName>();
    if (ids.size > 0) {
      const claimed = await rowsOf<{ id: number; record_type: TableName }>(
        client,
        `select id::float8 as id, record_type from embedded_agent_records where session_id = $1 and id = any($2::bigint[])
         union all
         select document_id::float8 as id, 'document' as record_type from embedded_agent_documents
          where session_id = $1 and row_kind = 'document' and document_id = any($2::bigint[])`,
        [sessionId, [...ids]],
      );
      for (const row of claimed) recordIds.set(row.id, row.record_type);
    }
    const documents = new Map<number, DocumentRecord>();
    if (documentIds.size > 0) {
      const found = await rowsOf<{ record: unknown }>(client, `select record from embedded_agent_documents where session_id = $1 and row_kind = 'document' and document_id = any($2::bigint[])`, [sessionId, [...documentIds]]);
      for (const row of found) {
        const record = parseRecord<DocumentRecord>(row.record);
        documents.set(record.id, record);
      }
    }
    const versions = new Map<number, number>();
    if (deltaIds.size > 0) {
      const latest = await rowsOf<{ document_id: number; version: number | null }>(
        client,
        `select requested.id::float8 as document_id, (
           select version from embedded_agent_documents r
            where r.session_id = $1 and r.row_kind = 'revision' and r.document_id = requested.id order by r.seq desc limit 1
         ) as version from unnest($2::bigint[]) as requested(id)`,
        [sessionId, [...deltaIds]],
      );
      for (const row of latest) if (row.version !== null) versions.set(row.document_id, row.version);
    }
    return new CommitState(recordIds, documents, versions, await readCurrent(client, sessionId, addresses));
  }

  check(writes: readonly StorageWrite[], actions: ReadonlyMap<DocumentId, DocumentAction>): void {
    this.#checkIds(writes);
    this.#checkDocuments(actions);
  }

  apply(writes: readonly StorageWrite[], actions: ReadonlyMap<DocumentId, DocumentAction>, seq: Seq): void {
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim !== undefined) this.#recordIds.set(claim.id, claim.table);
    }
    for (const [id, action] of actions) {
      if (action.create !== undefined) {
        const record = { ...action.create, createdAt: seq, ...(action.retire ? { retiredAt: seq } : {}) };
        this.#documents.set(id, record);
        if (!action.retire) this.#current.set(addressKey(record), id);
      } else if (action.retire) {
        const record = { ...this.#documents.get(id)!, retiredAt: seq };
        this.#documents.set(id, record);
        const key = addressKey(record);
        if (this.#current.get(key) === id) this.#current.set(key, undefined);
      }
      if (action.content !== undefined) this.#versions.set(id, action.content.version);
    }
  }

  document(id: DocumentId): DocumentRecord | undefined {
    return this.#documents.get(id);
  }

  #checkIds(writes: readonly StorageWrite[]): void {
    const claimed = new Map<Id<string>, TableName>();
    for (const write of writes) {
      const claim = claimOf(write);
      if (claim === undefined) continue;
      const { id, table } = claim;
      const existing = this.#recordIds.get(id);
      const earlier = claimed.get(id);
      if (table === "conversation" || table === "entry" || table === "document") {
        if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
      } else {
        if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
        if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
      }
      claimed.set(id, table);
    }
  }

  #checkDocuments(actions: ReadonlyMap<DocumentId, DocumentAction>): void {
    const liveCounts = new Map<string, number>();
    for (const [id, action] of actions) {
      if (action.copy !== undefined && actions.has(action.copy.id)) throw new Error(`Document copy ${id} source is changed in the copy batch`);
      const existing = this.#documents.get(id);
      if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
      if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
      if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
      if (action.content?.kind === "delta") {
        const previous = this.#versions.get(id);
        if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
        if (previous !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
      }
      if (action.create === undefined && !action.retire) continue;
      const key = addressKey(action.create ?? existing!);
      let live = liveCounts.get(key);
      if (live === undefined) live = this.#current.get(key) === undefined ? 0 : 1;
      if (action.retire && existing !== undefined) live--;
      if (action.create !== undefined && !action.retire) live++;
      liveCounts.set(key, live);
    }
    for (const live of liveCounts.values()) {
      if (live > 1) throw new Error("Document address already has a current incarnation");
    }
  }
}

async function readCurrent(client: Query, sessionId: string, addresses: ReadonlyMap<string, ReturnType<typeof addressParts>>): Promise<Map<string, DocumentId | undefined>> {
  const current = new Map<string, DocumentId | undefined>();
  for (const key of addresses.keys()) current.set(key, undefined);
  if (addresses.size === 0) return current;
  const parts = [...addresses.values()];
  const rows = await rowsOf<{ id: number; kind: string; scope_kind: string; owner_id: number; family: number; key_value: string }>(
    client,
    `select d.document_id::float8 as id, d.kind, d.scope_kind, d.owner_id::float8 as owner_id, d.family::int as family, d.key_value
       from unnest($2::text[], $3::text[], $4::bigint[], $5::int[], $6::text[]) as a(kind, scope_kind, owner_id, family, key_value)
       join embedded_agent_documents d on d.session_id = $1 and d.row_kind = 'document'
        and d.kind = a.kind and d.scope_kind = a.scope_kind and d.owner_id = a.owner_id and d.family = a.family and d.key_value = a.key_value
      where d.retired_at is null`,
    [sessionId, parts.map((p) => p.kind), parts.map((p) => p.scopeKind), parts.map((p) => p.ownerId), parts.map((p) => p.family), parts.map((p) => p.keyValue)],
  );
  for (const row of rows) current.set(addressColumnsKey(row.kind, row.scope_kind, row.owner_id, row.family, row.key_value), row.id as DocumentId);
  return current;
}

/** The writes of the accepted batches not yet written, as their net effect, written a few statements per table. */
export class PendingWrites {
  readonly #conversations: Cell[][] = [];
  readonly #entries: Cell[][] = [];
  readonly #tasks = new Map<number, Cell[]>();
  readonly #submissions = new Map<number, Cell[]>();
  readonly #documents = new Map<number, DocumentRecord>();
  readonly #cleared = new Set<number>();
  readonly #revisions = new Map<number, Cell[][]>();

  add(writes: readonly StorageWrite[], actions: ReadonlyMap<DocumentId, DocumentAction>, seq: Seq, state: CommitState): void {
    for (const write of writes) this.#addWrite(write, seq);
    for (const [id, action] of actions) this.#addDocument(id, action, seq, state.document(id)!);
  }

  #addWrite(write: StorageWrite, seq: Seq): void {
    switch (write.type) {
      case "conversation":
        this.#conversations.push([write.value.id, write.value.owner?.conversationId ?? null, write.value.owner?.taskId ?? null, encodeJson(write.value)]);
        break;
      case "entry":
        this.#entries.push([write.value.id, write.value.conversationId, write.value.head ?? null, seq, encodeJson(write.value)]);
        break;
      case "task":
        this.#tasks.set(write.value.id, [write.value.id, write.value.conversationId, encodeIndexedString(write.value.kind), write.value.state.status, !!write.value.abortRequested, !!write.value.background, encodeJson(write.value)]);
        break;
      case "submission":
        this.#submissions.set(write.value.id, [write.value.id, write.value.conversationId, write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId), write.value.status, encodeJson(write.value)]);
        break;
      default:
        break;
    }
  }

  #addDocument(id: DocumentId, action: DocumentAction, seq: Seq, record: DocumentRecord): void {
    if (action.create !== undefined || action.retire) this.#documents.set(id, record);
    const content = action.content;
    if (content !== undefined) {
      if (content.kind === "base" && isCurrentOnly(record)) this.#clear(id);
      const encoded = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
      let revisions = this.#revisions.get(id);
      if (revisions === undefined) {
        revisions = [];
        this.#revisions.set(id, revisions);
      }
      revisions.push([id, seq, content.kind, content.version, encoded]);
    }
    if (action.retire && isCurrentOnly(record)) this.#clear(id);
  }

  #clear(id: number): void {
    this.#cleared.add(id);
    this.#revisions.delete(id);
  }

  async flush(client: Query, sessionId: string): Promise<void> {
    const col = (rows: readonly Cell[][], index: number) => rows.map((row) => row[index]);
    if (this.#conversations.length > 0) {
      const r = this.#conversations;
      await client.query(
        `insert into embedded_agent_records (session_id, id, record_type, owner_conversation_id, owner_task_id, record)
         select $1, id, 'conversation', oc, ot, rec::json from unnest($2::bigint[], $3::bigint[], $4::bigint[], $5::text[]) as t(id, oc, ot, rec)`,
        [sessionId, col(r, 0), col(r, 1), col(r, 2), col(r, 3)],
      );
    }
    if (this.#entries.length > 0) {
      const r = this.#entries;
      await client.query(
        `insert into embedded_agent_records (session_id, id, record_type, conversation_id, head, commit_seq, record)
         select $1, id, 'entry', cid, head, seq, rec::json from unnest($2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[], $6::text[]) as t(id, cid, head, seq, rec)`,
        [sessionId, col(r, 0), col(r, 1), col(r, 2), col(r, 3), col(r, 4)],
      );
    }
    if (this.#tasks.size > 0) {
      const r = [...this.#tasks.values()];
      await client.query(
        `insert into embedded_agent_records (session_id, id, record_type, conversation_id, task_kind, status, abort_requested, background, record)
         select $1, id, 'task', cid, kind, status, abort, bg, rec::json
           from unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::boolean[], $7::boolean[], $8::text[]) as t(id, cid, kind, status, abort, bg, rec)
         on conflict (session_id, id) do update set conversation_id = excluded.conversation_id, task_kind = excluded.task_kind,
           status = excluded.status, abort_requested = excluded.abort_requested, background = excluded.background, record = excluded.record`,
        [sessionId, col(r, 0), col(r, 1), col(r, 2), col(r, 3), col(r, 4), col(r, 5), col(r, 6)],
      );
    }
    if (this.#submissions.size > 0) {
      const r = [...this.#submissions.values()];
      await client.query(
        `insert into embedded_agent_records (session_id, id, record_type, conversation_id, request_id, status, record)
         select $1, id, 'submission', cid, req, status, rec::json from unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[]) as t(id, cid, req, status, rec)
         on conflict (session_id, id) do update set conversation_id = excluded.conversation_id, request_id = excluded.request_id,
           status = excluded.status, record = excluded.record`,
        [sessionId, col(r, 0), col(r, 1), col(r, 2), col(r, 3), col(r, 4)],
      );
    }
    if (this.#documents.size > 0) {
      const records = [...this.#documents.values()];
      const parts = records.map((record) => addressParts(record));
      await client.query(
        `insert into embedded_agent_documents (session_id, document_id, row_kind, seq, kind, family, scope_kind, owner_id, key_value, created_at_ms, retired_at, record)
         select $1, id, 'document', 0, kind, family, scope_kind, owner_id, key_value, created, retired, rec::json
           from unnest($2::bigint[], $3::text[], $4::int[], $5::text[], $6::bigint[], $7::text[], $8::bigint[], $9::bigint[], $10::text[]) as t(id, kind, family, scope_kind, owner_id, key_value, created, retired, rec)
         on conflict (session_id, document_id, row_kind, seq) do update set retired_at = excluded.retired_at, record = excluded.record`,
        [sessionId, records.map((r) => r.id), parts.map((p) => p.kind), parts.map((p) => p.family), parts.map((p) => p.scopeKind), parts.map((p) => p.ownerId), parts.map((p) => p.keyValue), records.map((r) => r.createdAt), records.map((r) => r.retiredAt ?? null), records.map((r) => encodeJson(r))],
      );
    }
    if (this.#cleared.size > 0) {
      await client.query(`delete from embedded_agent_documents where session_id = $1 and row_kind = 'revision' and document_id = any($2::bigint[])`, [sessionId, [...this.#cleared]]);
    }
    const revisions = [...this.#revisions.values()].flat();
    if (revisions.length > 0) {
      await client.query(
        `insert into embedded_agent_documents (session_id, document_id, row_kind, seq, kind, version, record)
         select $1, id, 'revision', seq, kind, version, rec::json from unnest($2::bigint[], $3::int[], $4::text[], $5::int[], $6::text[]) as t(id, seq, kind, version, rec)`,
        [sessionId, col(revisions, 0), col(revisions, 1), col(revisions, 2), col(revisions, 3), col(revisions, 4)],
      );
    }
    this.#conversations.length = 0;
    this.#entries.length = 0;
    this.#tasks.clear();
    this.#submissions.clear();
    this.#documents.clear();
    this.#cleared.clear();
    this.#revisions.clear();
  }
}
