import type { AgentRunSpec } from "draft-core/run-spec";
import type { EmbeddedAgentAdapter, EmbeddedAgentContext, EmbeddedAgentFactory } from "../../embedded-agent/adapter";
import { OwnershipLostError } from "../../embedded-agent/pi/pg-storage";
import type { HostStore, PendingInput, RunPort, WakeBus } from "./ports";
import type { HomeSessionRef } from "./runs";

export interface HomeHostDeps {
  store: HostStore;
  factory: EmbeddedAgentFactory;
  runs: RunPort;
  bus: WakeBus;
  /** Copies committed events into the transcript. Returns the turns that ended. */
  project: (session: HomeSessionRef) => Promise<Array<{ requestId: string; outcome: string }>>;
  /** This process's owner id, unique for each start. */
  owner: string;
  instructions: () => string;
  maxActive?: number;
  idleMs?: number;
  claimTtlSeconds?: number;
  renewMs?: number;
  sweepMs?: number;
  /** For tests. */
  now?: () => number;
  onError?: (error: unknown, where: string) => void;
}

interface OpenHome {
  session: HomeSessionRef;
  adapter: EmbeddedAgentAdapter;
  epoch: number;
  alive: boolean;
  lastUsed: number;
  /** When the claim was last taken or extended. */
  renewedAt: number;
  run: { id: string; spec: AgentRunSpec } | null;
  stopCommitListener: () => void;
  renewTimer: ReturnType<typeof setInterval>;
  /** Work for one Home runs one step at a time. */
  queue: Promise<unknown>;
}

const APPLIED = new Set(["message", "permission_decision", "stop", "set_mode", "end"]);

/**
 * Runs Home's agents inside the backend: a bounded set of open agents, each driven by one process at a time through a claim
 * the process renews. An input is persisted first; the process that owns the Home submits it, so a crash between the two is
 * repaired by the next sweep (a repeated request id finds the first submission). If renewal fails, this process stops
 * admitting work and closes the agent; the claim is fenced in the database, so it cannot write either way.
 */
export class HomeHost {
  readonly #deps: Required<Pick<HomeHostDeps, "maxActive" | "idleMs" | "claimTtlSeconds" | "renewMs" | "sweepMs" | "now">> & HomeHostDeps;
  readonly #open = new Map<string, OpenHome>();
  readonly #opening = new Map<string, Promise<OpenHome | null>>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #stopListening: (() => void) | undefined;
  #stopped = false;

  constructor(deps: HomeHostDeps) {
    this.#deps = { maxActive: 50, idleMs: 10 * 60_000, claimTtlSeconds: 30, renewMs: 10_000, sweepMs: 5_000, now: Date.now, ...deps };
  }

  /** Starts listening for wakes and sweeping. */
  start(): void {
    this.#stopListening = this.#deps.bus.listen((sessionId) => {
      if (this.#open.has(sessionId)) void this.deliver(sessionId);
    });
    this.#sweepTimer = setInterval(() => void this.sweep(), this.#deps.sweepMs);
  }

  openSessionIds(): string[] {
    return [...this.#open.keys()];
  }

  /** Called when an input is saved. Delivers it here if this process can own the Home, and wakes the owner if another does. */
  async wake(sessionId: string): Promise<void> {
    if (this.#stopped) return;
    const delivered = await this.deliver(sessionId);
    if (!delivered) await this.#deps.bus.notify(sessionId);
  }

  /** Applies the inputs waiting for a Home, if this process owns it. False when another process does, or nothing could open. */
  async deliver(sessionId: string): Promise<boolean> {
    const home = await this.#ensureOpen(sessionId);
    if (!home) return false;
    return this.#step(home, () => this.#drain(home)).then(() => true);
  }

  /** Reopens Homes with work and no owner, and rechecks the ones this process owns: the sweep that repairs a crash or a lost wake. */
  async sweep(): Promise<void> {
    if (this.#stopped) return;
    try {
      const ids = new Set([...this.#open.keys(), ...(await this.#deps.store.sessionsNeedingRecovery())]);
      for (const id of ids) await this.deliver(id).catch((error) => this.#deps.onError?.(error, `sweep ${id}`));
      await this.#evictIdle();
    } catch (error) {
      this.#deps.onError?.(error, "sweep");
    }
  }

  /** The agent of a Home this process owns, for tools that must act through it. Null when it is not owned here. */
  home(sessionId: string): { epoch: number; alive: boolean } | null {
    const home = this.#open.get(sessionId);
    return home ? { epoch: home.epoch, alive: home.alive } : null;
  }

  /** Stops admitting work, closes every agent and gives up the claims. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#stopListening?.();
    await Promise.all([...this.#open.values()].map((home) => this.#close(home, true)));
  }

  async #ensureOpen(sessionId: string): Promise<OpenHome | null> {
    const existing = this.#open.get(sessionId);
    if (existing?.alive) {
      existing.lastUsed = this.#deps.now();
      return existing;
    }
    const pending = this.#opening.get(sessionId);
    if (pending) return pending;
    const opening = this.#openHome(sessionId).finally(() => this.#opening.delete(sessionId));
    this.#opening.set(sessionId, opening);
    return opening;
  }

  async #openHome(sessionId: string): Promise<OpenHome | null> {
    if (this.#stopped) return null;
    const { store, owner, claimTtlSeconds } = this.#deps;
    const session = await store.loadSession(sessionId);
    if (!session || session.ended) return null;
    if (this.#open.size >= this.#deps.maxActive && !(await this.#evictIdle(true))) return null;

    const claim = await store.claim(sessionId, owner, claimTtlSeconds);
    if (!claim.claimed) return null;

    let home!: OpenHome;
    const context: EmbeddedAgentContext = {
      sessionId,
      workspaceId: session.workspaceId,
      ownerUserId: session.ownerUserId,
      owner,
      epoch: claim.epoch,
      instructions: this.#deps.instructions(),
      assertOwner: () => {
        if (!home?.alive) throw new OwnershipLostError();
      },
      stillOwner: async () => !!home?.alive && (await store.stillOwner(sessionId, owner, claim.epoch)),
      currentRun: async () => (await this.#runFor(home)).spec,
    };
    const adapter = this.#deps.factory(context);
    home = {
      session,
      adapter,
      epoch: claim.epoch,
      alive: true,
      lastUsed: this.#deps.now(),
      renewedAt: this.#deps.now(),
      run: null,
      stopCommitListener: () => {},
      renewTimer: setInterval(() => void this.#renew(home), this.#deps.renewMs),
      queue: Promise.resolve(),
    };
    try {
      await adapter.open();
    } catch (error) {
      clearInterval(home.renewTimer);
      await store.release(sessionId, owner, claim.epoch).catch(() => {});
      throw error;
    }
    home.stopCommitListener = adapter.onCommit(() => void this.#step(home, () => this.#afterCommit(home)));
    this.#open.set(sessionId, home);
    // Whatever a crash left committed but not projected is copied now.
    void this.#step(home, () => this.#afterCommit(home));
    return home;
  }

  async #renew(home: OpenHome): Promise<void> {
    if (!home.alive) return;
    try {
      if (await this.#deps.store.renew(home.session.id, this.#deps.owner, home.epoch, this.#deps.claimTtlSeconds)) {
        home.renewedAt = this.#deps.now();
        return;
      }
    } catch (error) {
      this.#deps.onError?.(error, "renew");
      // A failed call is not proof of a lost claim: it lives for its whole term, so the next renewal may still succeed.
      // Past half the term, stop rather than risk acting without it.
      if (this.#deps.now() - home.renewedAt < (this.#deps.claimTtlSeconds * 1000) / 2) return;
    }
    await this.#close(home, false);
  }

  /** Runs `work` after the Home's earlier work, one step at a time. */
  #step<T>(home: OpenHome, work: () => Promise<T>): Promise<T> {
    const next = home.queue.then(work, work);
    home.queue = next.catch(() => {});
    return next;
  }

  async #runFor(home: OpenHome): Promise<{ id: string; spec: AgentRunSpec }> {
    home.run ??= await this.#deps.runs.open(home.session, this.#deps.instructions());
    return home.run;
  }

  async #drain(home: OpenHome): Promise<void> {
    if (!home.alive) return;
    const { store } = this.#deps;
    for (const input of await store.pendingInputs(home.session.id)) {
      if (!home.alive) return;
      if (!APPLIED.has(input.kind)) continue;
      try {
        await this.#apply(home, input);
      } catch (error) {
        if (error instanceof OwnershipLostError) {
          await this.#close(home, false);
          return;
        }
        this.#deps.onError?.(error, `input ${input.id}`);
        // The agent may have taken it before the call failed, so it is uncertain, not failed. A repeat is safe: ids repeat.
        await store.transition(input.id, home.session.id, ["delivering"], "uncertain", "delivery_failed").catch(() => {});
      }
    }
    await this.#afterCommit(home);
  }

  async #apply(home: OpenHome, input: PendingInput): Promise<void> {
    const { store } = this.#deps;
    const sessionId = home.session.id;
    const to = (state: string, from: string[], reason: string | null = null) => store.transition(input.id, sessionId, from, state, reason);
    if (input.state === "queued") await to("delivering", ["queued"]);

    switch (input.kind) {
      case "message": {
        await this.#runFor(home);
        const text = typeof input.payload.text === "string" ? input.payload.text : "";
        await home.adapter.submit({ text, authorUserId: input.authorUserId, whenBusy: input.payload.steer === true ? "steer" : "queue" }, input.id);
        // The projector settles the input as consumed when the person's message reaches the transcript.
        return;
      }
      case "permission_decision": {
        const requestId = String(input.payload.requestId ?? "");
        const decision = input.payload.decision === "allow" ? "allow" : "deny";
        const answers = input.payload.answers as Record<string, string> | undefined;
        const outcome = await home.adapter.answer(requestId, { inputId: input.id, decision, ...(answers ? { answers } : {}) });
        if (outcome.applied) await to("consumed", ["delivering", "uncertain"]);
        else await to("failed", ["delivering", "uncertain"], outcome.reason === "not_waiting" ? "request_closed" : (outcome.reason ?? "not_applied"));
        return;
      }
      case "stop": {
        await home.adapter.interrupt(input.id);
        await to("consumed", ["delivering", "uncertain"]);
        return;
      }
      case "set_mode": {
        const model = typeof input.payload.model === "string" ? input.payload.model : null;
        if (model) {
          const outcome = await home.adapter.setModel(input.id, { provider: "anthropic", model });
          if (outcome.applied) await store.setSessionModel(sessionId, model);
        }
        await to("consumed", ["delivering", "uncertain"]);
        return;
      }
      case "end":
        await to("consumed", ["delivering", "uncertain"]);
        return;
    }
  }

  /** After the agent committed something: copy it into the transcript, and end the run when its work is done. */
  async #afterCommit(home: OpenHome): Promise<void> {
    if (!home.alive) return;
    const settled = await this.#deps.project(home.session);
    if (settled.length > 0 || home.run) await this.#settle(home);
  }

  async #settle(home: OpenHome): Promise<void> {
    if (!home.run) return;
    if (await this.#deps.runs.settle(home.session.id, home.run.id)) home.run = null;
  }

  async #evictIdle(forRoom = false): Promise<boolean> {
    const now = this.#deps.now();
    const idle = [...this.#open.values()]
      .filter((home) => !home.run && now - home.lastUsed >= (forRoom ? 0 : this.#deps.idleMs))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let closed = false;
    for (const home of idle) {
      // Only a Home with nothing pending is closed: its next input reopens it from saved state.
      const pending = await this.#deps.store.pendingInputs(home.session.id);
      if (pending.length > 0) continue;
      await this.#close(home, true);
      closed = true;
      if (forRoom) return true;
    }
    return closed;
  }

  async #close(home: OpenHome, release: boolean): Promise<void> {
    if (!this.#open.delete(home.session.id) && !home.alive) return;
    home.alive = false;
    clearInterval(home.renewTimer);
    home.stopCommitListener();
    await home.adapter.close().catch((error) => this.#deps.onError?.(error, "close"));
    if (release) await this.#deps.store.release(home.session.id, this.#deps.owner, home.epoch).catch(() => {});
  }
}
