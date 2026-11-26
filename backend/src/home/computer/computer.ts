import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { CURRENT_CREDENTIAL_KEY_VERSION, decryptCredentialPayload, encryptCredentialPayload } from "../../credentials/crypto";
import { OwnershipLostError } from "../../embedded-agent/pi/pg-storage";
import type { SandboxProvider, SandboxRef } from "../../metaharness/sandbox/providers";
import { createComputerClient, type ComputerClient } from "./client";

export const COMPUTER_PORT = 8080;
const SIZE_GB = 5;

/** What Draft keeps about Home's computer. It outlives work episodes and backend restarts. */
export interface ComputerBinding {
  state: "creating" | "ready";
  token: string;
  /** The sandbox provider that made the machine, as its refs name it. Empty until a machine exists. */
  provider: string;
  machine: string;
  volume: SandboxRef["volume"];
  /** The computer's own id for its volume's contents. A new one means the files and job records are gone. */
  generation: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface BindingStore {
  load(): Promise<ComputerBinding | null>;
  /** Writes the binding when none exists. False when one already did. */
  create(binding: ComputerBinding): Promise<boolean>;
  save(binding: ComputerBinding): Promise<void>;
  clear(): Promise<void>;
}

type StoredBinding = Omit<ComputerBinding, "token"> & { tokenEncrypted: string; keyVersion: string };

/** The binding as a row of `embedded_agent_state`. The token is encrypted with the same key as stored logins and never logged. */
export function pgBindingStore(pool: Pool, sessionId: string): BindingStore {
  const toStored = (binding: ComputerBinding): StoredBinding => {
    const { token, ...rest } = binding;
    return { ...rest, tokenEncrypted: encryptCredentialPayload(token, CURRENT_CREDENTIAL_KEY_VERSION), keyVersion: CURRENT_CREDENTIAL_KEY_VERSION };
  };
  return {
    async load() {
      const { rows } = await pool.query(`select payload from embedded_agent_state where session_id = $1 and kind = 'computer' and key = 'binding'`, [sessionId]);
      const stored = rows[0]?.payload as StoredBinding | undefined;
      if (!stored) return null;
      const { tokenEncrypted, keyVersion, ...rest } = stored;
      return { ...rest, token: decryptCredentialPayload(tokenEncrypted, keyVersion) };
    },
    async create(binding) {
      const result = await pool.query(
        `insert into embedded_agent_state (session_id, kind, key, payload) values ($1, 'computer', 'binding', $2::jsonb) on conflict (session_id, kind, key) do nothing`,
        [sessionId, JSON.stringify(toStored(binding))],
      );
      return result.rowCount === 1;
    },
    async save(binding) {
      await pool.query(`update embedded_agent_state set payload = $2::jsonb, updated_at = now() where session_id = $1 and kind = 'computer' and key = 'binding'`, [sessionId, JSON.stringify(toStored(binding))]);
    },
    async clear() {
      await pool.query(`delete from embedded_agent_state where session_id = $1 and kind = 'computer' and key = 'binding'`, [sessionId]);
    },
  };
}

export interface HomeComputerDeps {
  provider: SandboxProvider;
  store: BindingStore;
  sessionId: string;
  /** Whether this process still owns Home at its epoch. Allocation and starting are effects, so they ask first. */
  stillOwner: () => Promise<boolean>;
  now?: () => number;
  fetch?: typeof fetch;
  /** How long to wait for a started machine to answer. */
  bootWaitMs?: number;
  retryDelaysMs?: readonly number[];
}

/** A stable id for the machine's volume name, so the same Home always names the same volume. */
const volumeRunId = (sessionId: string): string => {
  const hex = createHash("sha256").update(`home-computer:${sessionId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * Home's one computer: a sandbox machine with a volume, made the first time a tool needs it and kept. A stopped machine is
 * started in place; a machine that is gone is replaced on the same volume when the volume is still there. The binding is
 * saved before the machine is made, with a metadata mark on it, so a crash during allocation finds the one machine again.
 */
export class HomeComputer {
  readonly #deps: HomeComputerDeps;
  #ensuring: Promise<{ client: ComputerClient; generation: string }> | undefined;

  constructor(deps: HomeComputerDeps) {
    this.#deps = deps;
  }

  #now = () => (this.#deps.now ?? Date.now)();

  /** The running computer's client and its generation. Allocates, starts or replaces the machine as needed. */
  client(): Promise<{ client: ComputerClient; generation: string }> {
    this.#ensuring ??= this.#ensure().finally(() => (this.#ensuring = undefined));
    return this.#ensuring;
  }

  async #ensure(): Promise<{ client: ComputerClient; generation: string }> {
    const { provider, store } = this.#deps;
    if (!provider.endpoint) throw new Error("This sandbox provider cannot reach a computer");
    if (!(await this.#deps.stillOwner())) throw new OwnershipLostError();

    let binding = await store.load();
    if (!binding || binding.state === "creating") binding = await this.#allocate(binding);

    const ref = (): SandboxRef => ({ provider: binding!.provider, machine: binding!.machine, volume: binding!.volume });
    const status = await provider.status(ref());
    if (status === "missing") {
      // The machine is gone. Its volume, when it is still there, keeps the files and the job records.
      binding = await this.#replace(binding);
    } else if (status === "stopped") {
      await provider.start(ref());
    }

    const client = createComputerClient({
      endpoint: () => provider.endpoint!(ref(), COMPUTER_PORT),
      token: binding.token,
      fetch: this.#deps.fetch,
      retryDelaysMs: this.#deps.retryDelaysMs,
    });
    const generation = await this.#waitUntilReady(client);
    await store.save({ ...binding, generation, lastUsedAt: new Date(this.#now()).toISOString() });
    return { client, generation };
  }

  async #waitUntilReady(client: ComputerClient): Promise<string> {
    const deadline = this.#now() + (this.#deps.bootWaitMs ?? 90_000);
    let last: unknown;
    while (this.#now() < deadline) {
      try {
        return (await client.health()).generation;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw last instanceof Error ? last : new Error("The computer did not start in time");
  }

  async #allocate(reserved: ComputerBinding | null): Promise<ComputerBinding> {
    const { provider, store, sessionId } = this.#deps;
    const stamp = new Date(this.#now()).toISOString();
    // The reservation comes first, so two callers share one allocation and a crash leaves a mark to resume from.
    const mine: ComputerBinding = { state: "creating", token: randomBytes(32).toString("hex"), provider: "", machine: "", volume: null, generation: null, createdAt: stamp, lastUsedAt: stamp };
    if (!reserved && !(await store.create(mine))) reserved = await store.load();
    const binding = reserved ?? mine;
    if (binding.state === "ready") return binding;

    // A machine made before a crash carries the mark, so it is found, not made twice.
    const found = await provider.find?.({ key: "home_session", value: sessionId });
    const ref = found ?? (await this.#create(binding.token, null));
    const ready: ComputerBinding = { ...binding, state: "ready", provider: ref.provider, machine: ref.machine, volume: ref.volume };
    await store.save(ready);
    await provider.start(ref);
    return ready;
  }

  #create(token: string, existing: SandboxRef["volume"]): Promise<SandboxRef> {
    const { provider, sessionId } = this.#deps;
    return provider.create({
      runId: volumeRunId(sessionId),
      env: { DRAFT_MODE: "computer", DRAFT_COMPUTER_TOKEN: token },
      metadata: { home_session: sessionId, kind: "home_computer" },
      volume: existing ? { existing } : { sizeGb: SIZE_GB },
      expose: { port: COMPUTER_PORT },
    });
  }

  async #replace(binding: ComputerBinding): Promise<ComputerBinding> {
    const { provider, store } = this.#deps;
    if (!(await this.#deps.stillOwner())) throw new OwnershipLostError();
    let ref: SandboxRef;
    try {
      ref = await this.#create(binding.token, binding.volume);
    } catch {
      // The volume is gone too, so this is a new computer with new files.
      ref = await this.#create(binding.token, null);
    }
    const replaced: ComputerBinding = { ...binding, provider: ref.provider, machine: ref.machine, volume: ref.volume, generation: binding.volume?.id === ref.volume?.id ? binding.generation : null };
    await store.save(replaced);
    await provider.start(ref);
    return replaced;
  }

  /** Says the computer is in use, so a long command is not mistaken for an idle machine. */
  async touch(): Promise<void> {
    const binding = await this.#deps.store.load();
    if (binding?.state === "ready") await this.#deps.store.save({ ...binding, lastUsedAt: new Date(this.#now()).toISOString() });
  }

  /** Stops the machine when it has been unused for `idleMs`. The volume stays, and the next tool call starts it in place. */
  async stopIfIdle(idleMs: number): Promise<boolean> {
    const { provider, store } = this.#deps;
    const binding = await store.load();
    if (!binding || binding.state !== "ready" || !binding.machine) return false;
    if (this.#now() - Date.parse(binding.lastUsedAt) < idleMs) return false;
    const ref: SandboxRef = { provider: binding.provider, machine: binding.machine, volume: binding.volume };
    if ((await provider.status(ref)) !== "running") return false;
    await provider.stop(ref);
    return true;
  }

  /** Deletes the machine and its volume and forgets the binding, once the files are past their expiry. The transcript is not touched. */
  async expireIfOld(maxAgeMs: number): Promise<boolean> {
    const { provider, store } = this.#deps;
    const binding = await store.load();
    if (!binding || this.#now() - Date.parse(binding.lastUsedAt) < maxAgeMs) return false;
    await provider.destroy({ provider: binding.provider, machine: binding.machine, volume: binding.volume });
    await store.clear();
    return true;
  }
}
