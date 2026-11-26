import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { OwnershipLostError } from "../../embedded-agent/pi/pg-storage";
import { HomeComputer, type BindingStore, type ComputerBinding } from "../../home/computer/computer";
import { sweepComputers } from "../../home/computer/lifecycle";
import { LocalProvider } from "./local-provider";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V2 = randomBytes(32).toString("base64");
});

const memoryStore = (): BindingStore & { binding: ComputerBinding | null } => {
  const store = {
    binding: null as ComputerBinding | null,
    load: async () => store.binding,
    create: async (binding: ComputerBinding) => (store.binding ? false : ((store.binding = binding), true)),
    save: async (binding: ComputerBinding) => void (store.binding = binding),
    clear: async () => void (store.binding = null),
  };
  return store;
};

const providers: LocalProvider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose();
});

function setup(options: { owner?: () => Promise<boolean>; now?: () => number } = {}) {
  const provider = new LocalProvider();
  providers.push(provider);
  const store = memoryStore();
  let owner = options.owner ?? (async () => true);
  const computer = new HomeComputer({ provider, store, sessionId: "22222222-2222-4222-8222-222222222222", stillOwner: () => owner(), now: options.now, bootWaitMs: 5000, retryDelaysMs: [] });
  return { provider, store, computer, setOwner: (next: () => Promise<boolean>) => (owner = next) };
}

describe("Home's computer", () => {
  it("makes its machine on first use, starts it, and reuses it after", async () => {
    const { provider, computer, store } = setup();
    const first = await computer.client();
    await first.client.writeFile("a.txt", "hello", "k1");
    const second = await computer.client();
    expect(second.generation).toBe(first.generation);
    expect(provider.calls.filter((call) => call === "create")).toHaveLength(1);
    expect((await second.client.readFile("a.txt")).content).toBe("hello");
    expect(store.binding).toMatchObject({ state: "ready", provider: "local" });
    expect(store.binding!.token).toHaveLength(64);
  });

  it("starts a stopped machine in place, with its files, instead of making another", async () => {
    const { provider, computer } = setup();
    const { client } = await computer.client();
    await client.writeFile("keep.txt", "still here", "k1");
    const machine = [...provider.machines.values()][0]!;
    await provider.stop({ provider: "local", machine: machine.id, volume: null });
    const again = await computer.client();
    expect((await again.client.readFile("keep.txt")).content).toBe("still here");
    expect(provider.calls.filter((call) => call === "create")).toHaveLength(1);
  });

  it("replaces a machine that is gone on the same volume, keeping its files and its generation", async () => {
    const { provider, computer, store } = setup();
    const first = await computer.client();
    await first.client.writeFile("keep.txt", "survives", "k1");
    const old = store.binding!;
    await provider.destroyMachine({ provider: "local", machine: old.machine, volume: old.volume });
    const next = await computer.client();
    expect(store.binding!.machine).not.toBe(old.machine);
    expect(next.generation).toBe(first.generation);
    expect((await next.client.readFile("keep.txt")).content).toBe("survives");
  });

  it("makes a new computer with a new generation when the volume is gone too", async () => {
    const { provider, computer, store } = setup();
    const first = await computer.client();
    await first.client.writeFile("lost.txt", "x", "k1");
    const old = store.binding!;
    await provider.destroy({ provider: "local", machine: old.machine, volume: old.volume });
    const next = await computer.client();
    expect(next.generation).not.toBe(first.generation);
    await expect(next.client.readFile("lost.txt")).rejects.toMatchObject({ code: "not_found" });
  });

  it("ends with one machine when a crash left a reservation and a made machine, found by its mark", async () => {
    const { provider, computer, store } = setup();
    // A first attempt reserved, made the machine and crashed before saving it.
    store.binding = { state: "creating", token: "a".repeat(64), provider: "", machine: "", volume: null, generation: null, createdAt: "2026-01-01T00:00:00Z", lastUsedAt: "2026-01-01T00:00:00Z" };
    const made = await provider.create({ runId: "r", env: { DRAFT_COMPUTER_TOKEN: "a".repeat(64) }, metadata: { home_session: "22222222-2222-4222-8222-222222222222" }, volume: { sizeGb: 1 }, expose: { port: 8080 } });
    await computer.client();
    expect(provider.machines.size).toBe(1);
    expect(store.binding).toMatchObject({ state: "ready", machine: made.machine });
  });

  it("shares one allocation between two callers at once", async () => {
    const { provider, computer } = setup();
    await Promise.all([computer.client(), computer.client(), computer.client()]);
    expect(provider.machines.size).toBe(1);
  });

  it("does nothing, and makes nothing, when this process no longer owns Home", async () => {
    const { provider, computer } = setup({ owner: async () => false });
    await expect(computer.client()).rejects.toBeInstanceOf(OwnershipLostError);
    expect(provider.calls).toEqual([]);
  });

  it("stops an idle machine and starts it again on the next use, and deletes everything past its expiry", async () => {
    let clock = Date.parse("2026-11-26T10:00:00Z");
    const { provider, computer, store } = setup({ now: () => clock });
    await computer.client();
    expect(await computer.stopIfIdle(15 * 60_000)).toBe(false);
    clock += 16 * 60_000;
    expect(await computer.stopIfIdle(15 * 60_000)).toBe(true);
    expect(await provider.status({ provider: "local", machine: store.binding!.machine, volume: store.binding!.volume })).toBe("stopped");
    await computer.client();
    expect(provider.calls.filter((call) => call === "create")).toHaveLength(1);

    clock += 15 * 24 * 60 * 60_000;
    expect(await computer.expireIfOld(14 * 24 * 60 * 60_000)).toBe(true);
    expect(store.binding).toBeNull();
    expect(provider.machines.size).toBe(0);
    expect(provider.volumes.size).toBe(0);
  });
});

describe("sweeping Home's computers", () => {
  it("stops the idle one, leaves the one in use, removes an expired one, and carries on past a failure", async () => {
    let clock = Date.parse("2026-11-26T10:00:00Z");
    const a = setup({ now: () => clock });
    const b = setup({ now: () => clock });
    const c = setup({ now: () => clock });
    await a.computer.client();
    await b.computer.client();
    await c.computer.client();
    clock += 20 * 60_000;
    await b.computer.touch(); // in use now
    const errors: string[] = [];
    const byId: Record<string, ReturnType<typeof setup> | "broken"> = { a, b, c, d: "broken" };
    const result = await sweepComputers({
      sessions: async () => ["d", "a", "b"],
      computerFor: (id) => {
        const entry = byId[id];
        if (entry === "broken") throw new Error("no such computer");
        return entry!.computer;
      },
      onError: (_error, id) => void errors.push(id),
    });
    expect(result).toEqual({ stopped: 1, expired: 0 });
    expect(errors).toEqual(["d"]);
    expect(await a.provider.status({ provider: "local", machine: a.store.binding!.machine, volume: null })).toBe("stopped");
    expect(await b.provider.status({ provider: "local", machine: b.store.binding!.machine, volume: null })).toBe("running");

    clock += 15 * 24 * 60 * 60_000;
    const expired = await sweepComputers({ sessions: async () => ["c"], computerFor: () => c.computer });
    expect(expired).toEqual({ stopped: 0, expired: 1 });
    expect(c.store.binding).toBeNull();
  });
});
