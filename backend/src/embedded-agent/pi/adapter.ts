import type { Pool } from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, type Conversation, type ToolRegistration } from "@earendil-works/pi-durable";
import type {
  ControlOutcome,
  EmbeddedAgentAdapter,
  EmbeddedAgentContext,
  EmbeddedAgentFactory,
  EmbeddedAnswer,
  EmbeddedEvent,
  EmbeddedEventBody,
  EmbeddedInput,
  EmbeddedModelRef,
  LiveTextPart,
  SubmitReceipt,
} from "../adapter";
import { AskAnswer, createAskExtension, createGate, type CardRequest, type Gate } from "./ask-tool";
import { INPUT_ENTRY_KIND, normalizeWrites } from "./normalize";
import { PgStorage } from "./pg-storage";

const ctx = BACKGROUND_CONTEXT;
const ASK = "ask";
const CONTROL = "control";
/** Side rows sort after the commit rows that were written before them. */
const SIDE_ORDINAL = 9000;

export interface PiAgentDeps {
  pool: Pool;
  models: Models;
  defaultModel: EmbeddedModelRef;
  /** Draft's tools, and any others, as pi tools. The question tool is always added. */
  tools?: (context: EmbeddedAgentContext, gate: Gate) => ToolRegistration[];
  onReport?: (error: unknown) => void;
  /** How long a reader of events() waits between checks when nothing signals a commit. */
  pollMs?: number;
}

type Block = { type: string; text?: string };

/**
 * An embedded agent on pi-durable and Postgres: pi's harness over PgStorage, with Draft's tools, Draft's own record of what
 * the agent did (the outbox, written in each commit's transaction) and Draft's controls (stop, model, answer). pi is not
 * imported above this folder.
 */
export class PiEmbeddedAgent implements EmbeddedAgentAdapter {
  readonly adapterId = "pi-durable-sdk";

  readonly #context: EmbeddedAgentContext;
  readonly #deps: PiAgentDeps;
  #storage!: PgStorage;
  #harness!: Harness;
  #root!: Conversation;
  #closed = false;
  #commitListeners = new Set<() => void>();
  #waiters: Array<() => void> = [];

  constructor(context: EmbeddedAgentContext, deps: PiAgentDeps) {
    this.#context = context;
    this.#deps = deps;
  }

  async open(): Promise<void> {
    const { sessionId, owner, epoch } = this.#context;
    this.#storage = await PgStorage.open({
      pool: this.#deps.pool,
      sessionId,
      owner,
      epoch,
      outbox: (writes) => normalizeWrites(writes),
      onCommitted: () => this.#committed(),
    });
    const registry = createRegistry();
    const hooks = { open: (card: CardRequest & { toolCallId: string; taskId: number }) => this.#openAsk(card), cancel: (toolCallId: string) => this.#cancelAsk(toolCallId) };
    const gate = createGate(hooks);
    registry.install(createAskExtension(hooks, gate));
    const extra = this.#deps.tools?.(this.#context, gate) ?? [];
    if (extra.length > 0) registry.install(defineExtension({ name: "draft-tools", tools: extra }));
    this.#harness = await Harness.open(
      this.#storage,
      { models: this.#deps.models, registry, onReport: ({ error }) => this.#deps.onReport?.(error) },
      ctx,
    );
    const { provider, model } = this.#deps.defaultModel;
    this.#root = await this.#harness.root(ctx, { agent: { model: { provider, modelId: model }, instructions: this.#context.instructions } });
    // Work a crash left unfinished picks up here.
    this.#harness.resume();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const wake of this.#waiters.splice(0)) wake();
    try {
      await this.#harness?.close(ctx);
    } finally {
      await this.#storage?.close(ctx);
    }
  }

  onCommit(listener: () => void): () => void {
    this.#commitListeners.add(listener);
    return () => this.#commitListeners.delete(listener);
  }

  async submit(input: EmbeddedInput, requestId: string): Promise<SubmitReceipt> {
    this.#assertRunning();
    const earlier = await this.#storage.submissionByRequest(this.#root.id, requestId, ctx);
    await this.#root.submit(
      {
        type: "input",
        content: input.text,
        requestId,
        entry: { kind: INPUT_ENTRY_KIND, data: { requestId, text: input.text, authorUserId: input.authorUserId } },
        ...(input.whenBusy === "steer" ? { whenBusy: "steer" as const } : {}),
      },
      ctx,
    );
    return { requestId, duplicate: earlier !== undefined };
  }

  async interrupt(controlId: string): Promise<ControlOutcome> {
    return this.#control(controlId, async () => {
      const live = await this.#liveRun();
      if (!live) return { applied: false, reason: "idle" };
      await this.#root.abort(ctx);
      return { applied: true };
    });
  }

  async setModel(controlId: string, model: EmbeddedModelRef): Promise<ControlOutcome> {
    return this.#control(controlId, async () => {
      await this.#root.configure({ model: { provider: model.provider, modelId: model.model } }, ctx);
      return { applied: true };
    });
  }

  async answer(toolCallId: string, answer: EmbeddedAnswer): Promise<ControlOutcome> {
    return this.#control(answer.inputId, async () => {
      const row = await this.#askRow(toolCallId);
      if (!row || row.resolved) return { applied: false, reason: "not_waiting" };
      const text = answer.answers ? Object.values(answer.answers).join("; ") : undefined;
      const result = await this.#harness.signal(row.taskId as never, AskAnswer, toolCallId, { decision: answer.decision, ...(text ? { text } : {}) }, ctx);
      if (result !== "delivered" && result !== "duplicate") return { applied: false, reason: "not_waiting" };
      await this.#closeAsk(toolCallId, answer.decision, answer.answers);
      return { applied: true };
    });
  }

  async *events(afterSeq = 0): AsyncIterable<EmbeddedEvent> {
    let cursor = afterSeq;
    while (!this.#closed) {
      const { rows } = await this.#deps.pool.query(
        `select key, (seq * 10000 + (payload->>'ordinal')::int)::float8 as pos, payload->'event' as event from embedded_agent_state
          where session_id = $1 and kind = 'outbox' and (seq * 10000 + (payload->>'ordinal')::int) > $2 order by pos limit 200`,
        [this.#context.sessionId, cursor],
      );
      for (const row of rows) {
        cursor = Number(row.pos);
        yield { seq: cursor, sourceId: row.key as string, at: row.event.at as string, body: row.event.body as EmbeddedEventBody };
      }
      if (rows.length === 0) await new Promise<void>((resolve) => { this.#waiters.push(resolve); setTimeout(resolve, this.#deps.pollMs ?? 500); });
    }
  }

  async *liveText(): AsyncIterable<LiveTextPart> {
    const parts: LiveTextPart[] = [];
    let wake = () => {};
    let shown = "";
    let running = false;
    const watch = await this.#root.watch(ctx);
    const consume = (value: unknown) => {
      const live = (value as { docs?: Record<string, { run?: unknown; generation?: { message?: unknown } }> }).docs?.["pi.live"];
      const message = live?.generation?.message as { content?: Block[]; value?: { content?: Block[] } } | undefined;
      const blocks = message?.content ?? message?.value?.content ?? [];
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      const requestId = "reply";
      if (text.startsWith(shown) && text.length > shown.length) {
        parts.push({ requestId, text: text.slice(shown.length), done: false });
        shown = text;
        running = true;
      } else if (!text.startsWith(shown)) {
        shown = text;
      }
      if (live?.run === undefined && running) {
        parts.push({ requestId, text: "", done: true });
        shown = "";
        running = false;
      }
      wake();
    };
    consume(watch.value);
    watch.start(async (call) => {
      if (call.kind === "value") consume(call.value);
    });
    try {
      while (!this.#closed) {
        const next = parts.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 1000);
        });
      }
    } finally {
      await watch.stop().catch(() => {});
    }
  }

  async #liveRun(): Promise<boolean> {
    const { rows } = await this.#deps.pool.query(
      `select 1 from embedded_agent_records where session_id = $1 and record_type = 'task' and task_kind = '"pi.generation"' and status <> 'terminal' limit 1`,
      [this.#context.sessionId],
    );
    return rows.length > 0;
  }

  /** Runs a control once per id: a repeat returns what the first one did, also after a restart. */
  async #control(controlId: string, apply: () => Promise<{ applied: boolean; reason?: string }>): Promise<ControlOutcome> {
    this.#assertRunning();
    const { rows } = await this.#deps.pool.query(`select payload from embedded_agent_state where session_id = $1 and kind = $2 and key = $3`, [this.#context.sessionId, CONTROL, controlId]);
    if (rows[0]) return { controlId, ...(rows[0].payload as { applied: boolean; reason?: string }) };
    const outcome = await apply();
    await this.#deps.pool.query(
      `insert into embedded_agent_state (session_id, kind, key, payload) values ($1, $2, $3, $4::jsonb) on conflict (session_id, kind, key) do nothing`,
      [this.#context.sessionId, CONTROL, controlId, JSON.stringify(outcome)],
    );
    return { controlId, ...outcome };
  }

  async #askRow(toolCallId: string): Promise<{ taskId: number; resolved: boolean } | null> {
    const { rows } = await this.#deps.pool.query(`select payload from embedded_agent_state where session_id = $1 and kind = $2 and key = $3`, [this.#context.sessionId, ASK, toolCallId]);
    const payload = rows[0]?.payload as { taskId: number; resolved?: boolean } | undefined;
    return payload ? { taskId: payload.taskId, resolved: payload.resolved === true } : null;
  }

  async #openAsk(ask: CardRequest & { toolCallId: string; taskId: number }): Promise<void> {
    this.#context.assertOwner();
    const questions = ask.requestKind === "question" ? [{ question: ask.question ?? "", ...(ask.options?.length ? { options: ask.options } : {}) }] : undefined;
    await this.#sideWrite(
      async (client) => {
        await client.query(
          `insert into embedded_agent_state (session_id, kind, key, payload) values ($1, $2, $3, $4::jsonb) on conflict (session_id, kind, key) do nothing`,
          [this.#context.sessionId, ASK, ask.toolCallId, JSON.stringify({ taskId: ask.taskId })],
        );
      },
      `ask:${ask.toolCallId}`,
      { kind: "permission_request", toolCallId: ask.toolCallId, requestKind: ask.requestKind, name: ask.name, input: ask.input, ...(questions ? { questions } : {}) },
    );
  }

  async #cancelAsk(toolCallId: string): Promise<void> {
    if ((await this.#askRow(toolCallId))?.resolved) return;
    await this.#closeAsk(toolCallId, "cancelled");
  }

  async #closeAsk(toolCallId: string, decision: "allow" | "deny" | "cancelled", answers?: Readonly<Record<string, string>>): Promise<void> {
    await this.#sideWrite(
      async (client) => {
        await client.query(`update embedded_agent_state set payload = payload || '{"resolved": true}'::jsonb, updated_at = now() where session_id = $1 and kind = $2 and key = $3`, [this.#context.sessionId, ASK, toolCallId]);
      },
      `asked:${toolCallId}`,
      { kind: "permission_resolved", toolCallId, decision, ...(answers ? { answers } : {}) },
    );
  }

  /** A row the adapter writes outside a pi commit, beside the commit rows, under a source id that makes a repeat harmless. */
  async #sideWrite(work: (client: import("pg").PoolClient) => Promise<void>, sourceId: string, body: EmbeddedEventBody): Promise<void> {
    const client = await this.#deps.pool.connect();
    try {
      await client.query("begin");
      await work(client);
      await client.query(
        `insert into embedded_agent_state (session_id, kind, key, seq, payload)
         select $1, 'outbox', $2, greatest((select (payload->>'next_seq')::bigint - 1 from embedded_agent_state where session_id = $1 and kind = 'counter' and key = 'ids'), 0), $3::jsonb
         on conflict (session_id, kind, key) do nothing`,
        [this.#context.sessionId, sourceId, JSON.stringify({ ordinal: SIDE_ORDINAL, event: { at: new Date().toISOString(), body } })],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    this.#committed();
  }

  #committed(): void {
    for (const wake of this.#waiters.splice(0)) wake();
    for (const listener of this.#commitListeners) listener();
  }

  #assertRunning(): void {
    if (this.#closed) throw new Error("The embedded agent is closed");
  }
}

export function createPiAgentFactory(deps: PiAgentDeps | ((context: EmbeddedAgentContext) => PiAgentDeps)): EmbeddedAgentFactory {
  return (context) => new PiEmbeddedAgent(context, typeof deps === "function" ? deps(context) : deps);
}
