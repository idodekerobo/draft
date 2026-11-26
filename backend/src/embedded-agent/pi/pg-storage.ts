// pi-durable's `Storage` on Postgres, for one embedded agent (Home). Its records live in embedded_agent_records and
// embedded_agent_documents, scoped by session. The counter, the owner claim and the outbox live in embedded_agent_state.
// This is pi-durable's own SQLite storage, ported: the same reads, the same checks, the same net writes. What is new is the
// fence. Every commit holds the claim row in its own transaction, so a process that lost the claim cannot write, and it
// writes Draft's outbox rows in that same transaction.
import type { Pool, PoolClient } from "pg";
import type { Context } from "@earendil-works/chord/context";
import { apply, type Op } from "@earendil-works/chord/delta";
import {
  StorageRequestError,
  type CommitResult,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentContent,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type JsonObject,
  type Page,
  type ScanOrder,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { CommitState, claimOf, type DocumentAction, PendingWrites, prepareDocumentActions } from "./pg-commit";
import { addressParts, encodeIndexedString, isCurrentOnly, parseRecord, scopeColumns } from "./pg-rows";

type StoredTask = TaskRecord<never, never, never>;
type Row<T> = T;

/** A row Draft wants written beside a commit, in the same transaction. The projector copies it into session_events. */
export interface OutboxRow {
  sourceId: string;
  payload: unknown;
}

export interface PgStorageOptions {
  pool: Pool;
  sessionId: string;
  /** This process's claim: its owner id and the epoch `claim_embedded_agent` gave it. */
  owner: string;
  epoch: number;
  /** Draft's rows for one stored batch, written to the outbox with it. */
  outbox?: (writes: readonly StorageWrite[], seq: number) => readonly OutboxRow[];
}

/** The claim moved on or expired: this process may not write. pi treats it like any commit failure, which is final. */
export class OwnershipLostError extends Error {
  constructor(message = "This process no longer owns the embedded agent") {
    super(message);
    this.name = "OwnershipLostError";
  }
}

const COUNTER = "counter";
const IDS_KEY = "ids";

const idOf = <I extends Id<string>>(value: number): I => value as unknown as I;
const seqOf = (value: number): Seq => value as unknown as Seq;

const cursorId = (cursor: Cursor | undefined): number | undefined => {
  const after = cursor?.after;
  if (after === undefined) return undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new StorageRequestError("Invalid storage cursor");
  return after;
};

type ScanStart = { order: ScanOrder; after: number | undefined };

/** pi's scan rules: a cursor continues in the order it was made with, and a different order is refused. */
function scanStart(requested: ScanOrder | undefined, cursor: Readonly<Record<string, unknown>> | undefined, fallback: ScanOrder): ScanStart {
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
  const { after, order: stored } = cursor;
  if (typeof after !== "number" || !Number.isSafeInteger(after)) throw new StorageRequestError("Invalid storage cursor");
  if (stored !== undefined && stored !== "ascending" && stored !== "descending") throw new StorageRequestError("Invalid storage cursor");
  const order = (stored as ScanOrder | undefined) ?? fallback;
  if (requested !== undefined && requested !== order) throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
  return { order, after };
}

const page = <T extends { readonly id: Id<string> }>(values: readonly T[], limit: number, order: ScanOrder = "ascending"): Page<T, Cursor> => {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: items.at(-1)!.id as unknown as number, order } } as Page<T, Cursor>;
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
  if (at === "current") return record.retiredAt === undefined;
  return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

/** Builds `where` text with `?` marks as `$n`, starting after the session id. */
class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];
  constructor(private readonly base: number) {}
  and(clause: string, ...values: unknown[]): this {
    let index = this.base + this.params.length;
    this.clauses.push(clause.replace(/\?/g, () => `$${++index}`));
    this.params.push(...values);
    return this;
  }
  get sql(): string {
    return this.clauses.join(" and ");
  }
  limitParam(limit: number): string {
    this.params.push(limit);
    return `$${this.base + this.params.length}`;
  }
}

type Counter = { next_id: number; next_seq: number };

export class PgStorage implements Storage {
  readonly #pool: Pool;
  readonly #sessionId: string;
  readonly #owner: string;
  readonly #epoch: number;
  readonly #outbox: PgStorageOptions["outbox"];
  #nextId: number;
  #closed = false;
  #closing: Promise<void> | undefined;
  #admittedReads = 0;
  #readsDrained: (() => void) | undefined;

  private constructor(options: PgStorageOptions, nextId: number) {
    this.#pool = options.pool;
    this.#sessionId = options.sessionId;
    this.#owner = options.owner;
    this.#epoch = options.epoch;
    this.#outbox = options.outbox;
    this.#nextId = nextId;
  }

  /** Opens the agent's storage: creates its counter on first use and reads where the ids continue. */
  static async open(options: PgStorageOptions): Promise<PgStorage> {
    await options.pool.query(
      `insert into embedded_agent_state (session_id, kind, key, payload) values ($1, $2, $3, $4::jsonb) on conflict (session_id, kind, key) do nothing`,
      [options.sessionId, COUNTER, IDS_KEY, JSON.stringify({ next_id: 2, next_seq: 1 })],
    );
    const { rows } = await options.pool.query(`select payload from embedded_agent_state where session_id = $1 and kind = $2 and key = $3`, [options.sessionId, COUNTER, IDS_KEY]);
    const counter = rows[0]?.payload as Counter | undefined;
    if (!counter) throw new Error("The embedded agent counter is missing");
    return new PgStorage(options, Number(counter.next_id));
  }

  async commit(batches: readonly (readonly StorageWrite[])[], receive: (index: number, seq: Seq) => void, _context: Context): Promise<CommitResult> {
    this.#assertOpen();
    const seqs: Seq[] = [];
    let refused: { readonly error: unknown } | undefined;
    let candidateNextId = this.#nextId;

    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      try {
        await this.#holdClaim(client);
        const counter = await this.#readCounter(client);
        let next = counter.next_seq;
        const state = await CommitState.read(client, this.#sessionId, batches);
        const pending = new PendingWrites();
        const outbox: Array<{ sourceId: string; seq: number; ordinal: number; payload: unknown }> = [];
        for (const writes of batches) {
          const checked = await this.#checkBatch(client, state, pending, writes);
          if (checked.kind === "refused") {
            refused = { error: checked.refused };
            break;
          }
          const seq = seqOf(next++);
          state.apply(writes, checked.actions, seq);
          pending.add(writes, checked.actions, seq, state);
          seqs.push(seq);
          candidateNextId = Math.max(candidateNextId, this.#candidateNextId(writes));
          for (const [ordinal, row] of (this.#outbox?.(writes, seq) ?? []).entries()) outbox.push({ sourceId: row.sourceId, seq, ordinal, payload: row.payload });
        }
        await pending.flush(client, this.#sessionId);
        if (outbox.length > 0) await this.#writeOutbox(client, outbox);
        if (seqs.length > 0) await this.#writeCounter(client, Math.max(Number(counter.next_id), candidateNextId), next);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    } finally {
      client.release();
    }
    this.#nextId = Math.max(this.#nextId, candidateNextId);
    for (const [index, seq] of seqs.entries()) receive(index, seq);
    return refused === undefined ? { kind: "stored", stored: seqs.length } : { kind: "refused", stored: seqs.length, refused: refused.error };
  }

  /** Reads the claim row with a share lock held to the end of the transaction: a takeover waits for this commit, and this one fails after it. */
  async #holdClaim(client: PoolClient): Promise<void> {
    const { rows } = await client.query(
      `select payload->>'owner' as owner, (payload->>'epoch')::bigint::float8 as epoch, ((payload->>'expires_at')::timestamptz > now()) as live
         from embedded_agent_state where session_id = $1 and kind = 'claim' and key = 'owner' for share`,
      [this.#sessionId],
    );
    const claim = rows[0] as { owner: string | null; epoch: number | null; live: boolean | null } | undefined;
    if (!claim || claim.owner !== this.#owner || Number(claim.epoch) !== this.#epoch || claim.live !== true) throw new OwnershipLostError();
  }

  async #readCounter(client: PoolClient): Promise<Counter> {
    const { rows } = await client.query(`select payload from embedded_agent_state where session_id = $1 and kind = $2 and key = $3 for update`, [this.#sessionId, COUNTER, IDS_KEY]);
    const counter = rows[0]?.payload as Counter | undefined;
    if (!counter) throw new Error("The embedded agent counter is missing");
    return { next_id: Number(counter.next_id), next_seq: Number(counter.next_seq) };
  }

  async #writeCounter(client: PoolClient, nextId: number, nextSeq: number): Promise<void> {
    await client.query(`update embedded_agent_state set payload = $4::jsonb, updated_at = now() where session_id = $1 and kind = $2 and key = $3`, [this.#sessionId, COUNTER, IDS_KEY, JSON.stringify({ next_id: nextId, next_seq: nextSeq })]);
  }

  async #writeOutbox(client: PoolClient, rows: Array<{ sourceId: string; seq: number; ordinal: number; payload: unknown }>): Promise<void> {
    await client.query(
      `insert into embedded_agent_state (session_id, kind, key, seq, payload)
       select $1, 'outbox', key, seq, jsonb_build_object('ordinal', ordinal, 'event', payload::jsonb)
         from unnest($2::text[], $3::bigint[], $4::int[], $5::text[]) as t(key, seq, ordinal, payload)
       on conflict (session_id, kind, key) do nothing`,
      [this.#sessionId, rows.map((r) => r.sourceId), rows.map((r) => r.seq), rows.map((r) => r.ordinal), rows.map((r) => JSON.stringify(r.payload))],
    );
  }

  async #checkBatch(
    client: PoolClient,
    state: CommitState,
    pending: PendingWrites,
    writes: readonly StorageWrite[],
  ): Promise<{ readonly kind: "checked"; readonly actions: Map<DocumentId, DocumentAction> } | { readonly kind: "refused"; readonly refused: unknown }> {
    let actions: Map<DocumentId, DocumentAction>;
    try {
      actions = prepareDocumentActions(writes);
      state.check(writes, actions);
    } catch (error) {
      return { kind: "refused", refused: error };
    }
    if (![...actions.values()].some((action) => action.copy !== undefined)) return { kind: "checked", actions };
    await pending.flush(client, this.#sessionId);
    let databaseFailed = false;
    const watched: Pick<PoolClient, "query"> = {
      query: ((...args: Parameters<PoolClient["query"]>) =>
        (client.query as (...a: unknown[]) => Promise<unknown>)(...args).catch((error: unknown) => {
          databaseFailed = true;
          throw error;
        })) as PoolClient["query"],
    };
    try {
      await this.#resolveCopies(watched, actions);
    } catch (error) {
      if (databaseFailed) throw error;
      return { kind: "refused", refused: error };
    }
    return { kind: "checked", actions };
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    this.#assertOpen();
    if (!Number.isSafeInteger(this.#nextId)) throw new Error("ID space is exhausted");
    return idOf<I>(this.#nextId++);
  }

  async #record<T>(type: string, id: number): Promise<T | undefined> {
    const { rows } = await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = $2 and id = $3`, [this.#sessionId, type, id]);
    return rows[0] === undefined ? undefined : parseRecord<T>(rows[0].record);
  }

  async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    this.#assertOpen();
    return this.#record<ConversationRecord>("conversation", id);
  }

  async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<ConversationRecord, Cursor>> {
    this.#assertOpen();
    const start = scanStart(query.order, cursor, "ascending");
    const where = new Where(2);
    where.and(start.order === "ascending" ? "id > ?" : "id < ?", start.after ?? (start.order === "ascending" ? -1 : Number.MAX_SAFE_INTEGER));
    if (query.ownerConversationId !== undefined) where.and("owner_conversation_id = ?", query.ownerConversationId);
    if (query.ownerTaskId !== undefined) where.and("owner_task_id = ?", query.ownerTaskId);
    const limitParam = where.limitParam(limit + 1);
    const { rows } = await this.#pool.query(
      `select record from embedded_agent_records where session_id = $1 and record_type = $2 and ${where.sql} order by id ${start.order === "ascending" ? "asc" : "desc"} limit ${limitParam}`,
      [this.#sessionId, "conversation", ...where.params],
    );
    return page(rows.map((row) => parseRecord<ConversationRecord>(row.record)), limit, start.order);
  }

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, context?: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    return this.#admitRead(() => this.#readEntry(idOrConversationId, idOrContext, context));
  }

  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, _context: Context): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.#admitRead(() => this.#readLatestHeadMarker(conversationId, atOrBeforeEntryId));
  }

  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<EntryRecord, Cursor>> {
    return this.#admitRead(() => this.#readEntries(query, limit, cursor));
  }

  async #readEntry(idOrConversationId: EntryId | ConversationId, idOrContext: EntryId | Context, context?: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    const id = context === undefined ? idOf<EntryId>(idOrConversationId as number) : typeof idOrContext === "number" ? idOf<EntryId>(idOrContext) : undefined;
    if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
    let conversation: ConversationRecord | undefined;
    if (context !== undefined) {
      const conversationId = idOf<ConversationId>(idOrConversationId as number);
      conversation = await this.#record<ConversationRecord>("conversation", conversationId);
      if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    }
    const { rows } = await this.#pool.query(`select record, commit_seq::float8 as commit_seq from embedded_agent_records where session_id = $1 and record_type = 'entry' and id = $2`, [this.#sessionId, id]);
    if (rows[0] === undefined) return undefined;
    const entry = parseRecord<EntryRecord>(rows[0].record);
    if (conversation !== undefined) {
      let upperEntryId = Number.POSITIVE_INFINITY;
      while (conversation.id !== entry.conversationId) {
        if (conversation.parent === undefined) return undefined;
        upperEntryId = Math.min(upperEntryId, conversation.parent.at);
        conversation = (await this.#record<ConversationRecord>("conversation", conversation.parent.conversationId))!;
      }
      if (entry.id > upperEntryId) return undefined;
    }
    return { entry, commitSeq: seqOf(Number(rows[0].commit_seq)) };
  }

  async #readLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    let conversation = await this.#record<ConversationRecord>("conversation", conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
    let upper: number | undefined = atOrBeforeEntryId;
    while (true) {
      const { rows } =
        upper === undefined
          ? await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = 'entry' and conversation_id = $2 and head is not null order by id desc limit 1`, [this.#sessionId, conversation.id])
          : await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = 'entry' and conversation_id = $2 and head is not null and id <= $3 order by id desc limit 1`, [this.#sessionId, conversation.id, upper]);
      if (rows[0] !== undefined) return parseRecord<EntryRecord & { readonly head: EntryId }>(rows[0].record);
      if (conversation.parent === undefined) return undefined;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      conversation = (await this.#record<ConversationRecord>("conversation", conversation.parent.conversationId))!;
    }
  }

  async #readEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined): Promise<Page<EntryRecord, Cursor>> {
    const { order, after } = scanStart(query.order, cursor, "descending");
    if (order === "ascending") return this.#readEntriesAscending(query, limit, after);
    let conversation = await this.#record<ConversationRecord>("conversation", query.conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
    let upper: number | undefined = query.maxEntryId;
    if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
    const values: EntryRecord[] = [];
    while (true) {
      const where = new Where(2).and("conversation_id = ?", conversation.id);
      if (query.minEntryId !== undefined) where.and("id >= ?", query.minEntryId);
      if (upper !== undefined) where.and("id <= ?", upper);
      const limitParam = where.limitParam(limit + 1 - values.length);
      const { rows } = await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = $2 and ${where.sql} order by id desc limit ${limitParam}`, [this.#sessionId, "entry", ...where.params]);
      values.push(...rows.map((row) => parseRecord<EntryRecord>(row.record)));
      if (values.length > limit || conversation.parent === undefined) break;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = (await this.#record<ConversationRecord>("conversation", conversation.parent.conversationId))!;
    }
    return page(values, limit, "descending");
  }

  async #readEntriesAscending(query: EntryQuery, limit: number, after: number | undefined): Promise<Page<EntryRecord, Cursor>> {
    const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
    let conversation = await this.#record<ConversationRecord>("conversation", query.conversationId);
    if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
    let upper: number | undefined = query.maxEntryId;
    while (true) {
      segments.push({ conversationId: conversation.id, upper });
      if (conversation.parent === undefined) break;
      upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
      if (query.minEntryId !== undefined && upper < query.minEntryId) break;
      conversation = (await this.#record<ConversationRecord>("conversation", conversation.parent.conversationId))!;
    }
    let lower: number | undefined = query.minEntryId;
    if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
    const values: EntryRecord[] = [];
    for (const segment of segments.reverse()) {
      const where = new Where(2).and("conversation_id = ?", segment.conversationId);
      if (lower !== undefined) where.and("id >= ?", lower);
      if (segment.upper !== undefined) where.and("id <= ?", segment.upper);
      const limitParam = where.limitParam(limit + 1 - values.length);
      const { rows } = await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = $2 and ${where.sql} order by id asc limit ${limitParam}`, [this.#sessionId, "entry", ...where.params]);
      values.push(...rows.map((row) => parseRecord<EntryRecord>(row.record)));
      if (values.length > limit) break;
    }
    return page(values, limit, "ascending");
  }

  async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    this.#assertOpen();
    return this.#record<StoredTask>("task", id);
  }

  async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<StoredTask, Cursor>> {
    this.#assertOpen();
    const start = scanStart(query.order, cursor, "ascending");
    const where = new Where(2).and(start.order === "ascending" ? "id > ?" : "id < ?", start.after ?? (start.order === "ascending" ? -1 : Number.MAX_SAFE_INTEGER));
    if (query.conversationId !== undefined) where.and("conversation_id = ?", query.conversationId);
    if (query.kind !== undefined) where.and("task_kind = ?", encodeIndexedString(query.kind));
    if (query.status !== undefined) where.and("status = ?", query.status);
    if (query.abortRequested !== undefined) where.and("abort_requested = ?", query.abortRequested);
    if (query.background !== undefined) where.and("background = ?", query.background);
    const limitParam = where.limitParam(limit + 1);
    const { rows } = await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = $2 and ${where.sql} order by id ${start.order === "ascending" ? "asc" : "desc"} limit ${limitParam}`, [this.#sessionId, "task", ...where.params]);
    return page(rows.map((row) => parseRecord<StoredTask>(row.record)), limit, start.order);
  }

  async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    this.#assertOpen();
    return this.#record<SubmissionRecord>("submission", id);
  }

  async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<SubmissionRecord, Cursor>> {
    this.#assertOpen();
    const start = scanStart(query.order, cursor, "ascending");
    const where = new Where(2).and(start.order === "ascending" ? "id > ?" : "id < ?", start.after ?? (start.order === "ascending" ? -1 : Number.MAX_SAFE_INTEGER));
    if (query.conversationId !== undefined) where.and("conversation_id = ?", query.conversationId);
    if (query.status !== undefined) where.and("status = ?", query.status);
    const limitParam = where.limitParam(limit + 1);
    const { rows } = await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = $2 and ${where.sql} order by id ${start.order === "ascending" ? "asc" : "desc"} limit ${limitParam}`, [this.#sessionId, "submission", ...where.params]);
    return page(rows.map((row) => parseRecord<SubmissionRecord>(row.record)), limit, start.order);
  }

  async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context): Promise<SubmissionRecord | undefined> {
    this.#assertOpen();
    const { rows } = await this.#pool.query(`select record from embedded_agent_records where session_id = $1 and record_type = 'submission' and conversation_id = $2 and request_id = $3`, [this.#sessionId, conversationId, encodeIndexedString(requestId)]);
    return rows[0] === undefined ? undefined : parseRecord<SubmissionRecord>(rows[0].record);
  }

  async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
    this.#assertOpen();
    const parts = addressParts(address);
    const base = `select record from embedded_agent_documents where session_id = $1 and row_kind = 'document' and kind = $2 and scope_kind = $3 and owner_id = $4 and family = $5 and key_value = $6`;
    const params: unknown[] = [this.#sessionId, parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
    const { rows } =
      at === "current"
        ? await this.#pool.query(`${base} and retired_at is null order by created_at_ms desc limit 1`, params)
        : await this.#pool.query(`${base} and created_at_ms <= $7 and (retired_at is null or retired_at > $7) order by created_at_ms desc limit 1`, [...params, at]);
    return rows[0] === undefined ? undefined : parseRecord<DocumentRecord>(rows[0].record);
  }

  async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    this.#assertOpen();
    // The record and revision queries must see one committed state: a commit between them can replace the base.
    const client = await this.#pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      try {
        return await this.#materializeDocument(client, id, at);
      } finally {
        await client.query("rollback").catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<DocumentRecord, Cursor>> {
    this.#assertOpen();
    const scope = scopeColumns(query.scope);
    const where = new Where(2).and("scope_kind = ?", scope.scopeKind).and("owner_id = ?", scope.ownerId).and("document_id > ?", cursorId(cursor) ?? -1);
    if (query.kind !== undefined) where.and("kind = ?", encodeIndexedString(query.kind));
    if (query.at === "current") where.and("retired_at is null");
    else where.and("created_at_ms <= ?", query.at).and("(retired_at is null or retired_at > ?)", query.at);
    const limitParam = where.limitParam(limit + 1);
    const { rows } = await this.#pool.query(`select record from embedded_agent_documents where session_id = $1 and row_kind = $2 and ${where.sql} order by document_id limit ${limitParam}`, [this.#sessionId, "document", ...where.params]);
    return page(rows.map((row) => parseRecord<DocumentRecord>(row.record)), limit);
  }

  close(_context: Context): Promise<void> {
    if (this.#closing === undefined) {
      this.#closed = true;
      this.#closing = this.#drain();
    }
    return this.#closing;
  }

  /** The pool belongs to the caller, so closing waits for reads in flight and leaves the pool open. */
  async #drain(): Promise<void> {
    if (this.#admittedReads > 0) await new Promise<void>((resolve) => (this.#readsDrained = resolve));
  }

  async #admitRead<T>(read: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#admittedReads++;
    try {
      return await read();
    } finally {
      if (--this.#admittedReads === 0) this.#readsDrained?.();
    }
  }

  async #materializeDocument(client: Pick<PoolClient, "query">, id: DocumentId, at: DocumentPoint): Promise<StoredDocument | undefined> {
    const found = await client.query(`select record from embedded_agent_documents where session_id = $1 and row_kind = 'document' and document_id = $2`, [this.#sessionId, id]);
    if (found.rows[0] === undefined) return undefined;
    const record = parseRecord<DocumentRecord>(found.rows[0].record);
    if (at !== "current" && isCurrentOnly(record)) throw new StorageRequestError(`Document ${id} does not retain historical content`);
    if (!isAliveAt(record, at)) return undefined;
    const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
    const base = await client.query(
      `select seq::float8 as seq, kind, version::float8 as version, record as content from embedded_agent_documents
        where session_id = $1 and row_kind = 'revision' and document_id = $2 and kind = 'base' and seq <= $3::bigint order by seq desc limit 1`,
      [this.#sessionId, id, upper],
    );
    const baseRow = base.rows[0] as { seq: number; kind: DocumentContent["kind"]; version: number; content: unknown } | undefined;
    if (baseRow === undefined) throw new Error(`Document ${id} is missing a required base`);
    let value = parseRecord<JsonObject>(baseRow.content);
    const tail = await client.query(
      `select seq::float8 as seq, kind, version::float8 as version, record as content from embedded_agent_documents
        where session_id = $1 and row_kind = 'revision' and document_id = $2 and seq > $3::bigint and seq <= $4::bigint order by seq`,
      [this.#sessionId, id, baseRow.seq, upper],
    );
    for (const revision of tail.rows as Array<Row<{ seq: number; kind: DocumentContent["kind"]; version: number; content: unknown }>>) {
      if (revision.kind !== "delta" || Number(revision.version) !== Number(baseRow.version)) throw new Error(`Document ${id} crosses a stored version boundary without a base`);
      value = apply(value, parseRecord<readonly Op[]>(revision.content)) as JsonObject;
    }
    return { record, version: Number(baseRow.version), value, deltasSinceBase: tail.rows.length };
  }

  #candidateNextId(writes: readonly StorageWrite[]): number {
    let nextId = this.#nextId;
    for (const write of writes) {
      const id = claimOf(write)?.id;
      if (id !== undefined) nextId = Math.max(nextId, (id as unknown as number) + 1);
    }
    return nextId;
  }

  async #resolveCopies(client: Pick<PoolClient, "query">, actions: Map<DocumentId, DocumentAction>): Promise<void> {
    for (const [id, action] of actions) {
      if (action.copy === undefined) continue;
      try {
        const stored = await this.#materializeDocument(client, action.copy.id, action.copy.at);
        if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
        const create = action.create!;
        if (
          stored.record.scope.kind !== "conversation" ||
          create.scope.kind !== "conversation" ||
          stored.record.kind !== create.kind ||
          stored.record.key !== create.key ||
          stored.record.history !== create.history ||
          stored.record.fork !== create.fork
        ) {
          throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
        }
        action.content = { kind: "base", version: stored.version, value: stored.value };
      } catch (error) {
        throw new Error(`Document copy ${id} was rejected`, { cause: error });
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("PgStorage is closed");
  }
}
