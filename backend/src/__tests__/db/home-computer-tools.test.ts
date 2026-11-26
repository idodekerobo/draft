import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createPiAgentFactory } from "../../embedded-agent/pi/adapter";
import { HomeComputer, type BindingStore, type ComputerBinding } from "../../home/computer/computer";
import { createComputerTools } from "../../home/computer/tools";
import { LocalProvider } from "../home/local-provider";
import { collect, setCollectTimeout, settledFor } from "../embedded-agent/contract";
import { embeddedAgentDb, homeContext } from "./embedded-agent-fixture";

setCollectTimeout(90_000);

// Home's computer tools through pi, on staging Postgres, with pi's scripted model and a computer server running in this process.
const { describeWithDatabase, pool } = embeddedAgentDb;
const INPUT = (text: string) => ({ text, authorUserId: "33333333-3333-4333-8333-333333333333" });

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V2 = randomBytes(32).toString("base64");
});

const memoryStore = (): BindingStore => {
  let binding: ComputerBinding | null = null;
  return { load: async () => binding, create: async (b) => (binding ? false : ((binding = b), true)), save: async (b) => void (binding = b), clear: async () => void (binding = null) };
};

const providers: LocalProvider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose();
});

/** Calls one tool, then repeats what the tool said. */
const calling = (tool: string, args: object): FauxResponseStep[] => {
  const step: FauxResponseStep = (context, _options, _state, model) => {
    const last = context.messages.at(-1);
    const base = { provider: model.provider, model: model.id };
    if (last?.role === "toolResult") return { ...fauxAssistantMessage(`Result: ${(last.content as Array<{ text?: string }>).map((b) => b.text ?? "").join(" ")}`), ...base };
    return { ...fauxAssistantMessage([fauxToolCall(tool, args as never, { id: "call-1" })], { stopReason: "toolUse" }), ...base };
  };
  return Array.from({ length: 10 }, () => step);
};

function world() {
  const provider = new LocalProvider();
  providers.push(provider);
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const made = { computer: undefined as HomeComputer | undefined };
  const factory = createPiAgentFactory({
    pool: pool(), models, defaultModel: { provider: "faux", model: "faux-1" },
    tools: (context, _gate, lifecycle) => {
      made.computer ??= new HomeComputer({ provider, store: sharedStore, sessionId: context.sessionId, stillOwner: context.stillOwner, bootWaitMs: 8000, retryDelaysMs: [] });
      return createComputerTools({ computer: () => made.computer!, context, lifecycle });
    },
  });
  const sharedStore = memoryStore();
  return { provider, faux, factory };
}

describeWithDatabase("Home's computer tools", () => {
  it("runs a command on first use, makes the machine then, and returns its output and exit code", async () => {
    const { provider, faux, factory } = world();
    const made = await homeContext();
    faux.setResponses(calling("computer_run", { command: "echo hi > a.txt && cat a.txt" }));
    expect(provider.machines.size).toBe(0);
    const agent = factory(made.context);
    await agent.open();
    await agent.submit(INPUT("run it"), "in-1");
    const events = await collect(agent, settledFor("in-1"));
    expect(provider.machines.size).toBe(1);
    const result = events.find((event) => event.body.kind === "tool_result")!.body as { content: string; isError: boolean };
    expect(result.content).toContain("hi");
    expect(result.content).toContain("[exit code 0]");
    expect(result.isError).toBe(false);
    await agent.close();
    await made.cleanup();
  }, 120_000);

  it("reports a failing command as an error with its exit code", async () => {
    const { faux, factory } = world();
    const made = await homeContext();
    faux.setResponses(calling("computer_run", { command: "echo nope >&2; exit 4" }));
    const agent = factory(made.context);
    await agent.open();
    await agent.submit(INPUT("run it"), "in-1");
    const result = (await collect(agent, settledFor("in-1"))).find((event) => event.body.kind === "tool_result")!.body as { content: string; isError: boolean };
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("[exit code 4]");
    await agent.close();
    await made.cleanup();
  }, 120_000);

  it("writes, reads and lists files in the workspace", async () => {
    const { faux, factory } = world();
    const made = await homeContext();
    const agent = factory(made.context);
    await agent.open();
    const steps: Array<[string, object, string]> = [
      ["computer_write_file", { path: "notes/todo.txt", content: "buy milk" }, "Wrote notes/todo.txt."],
      ["computer_read_file", { path: "notes/todo.txt" }, "buy milk"],
      ["computer_list", { path: "notes" }, "todo.txt (8 bytes)"],
    ];
    for (const [index, [tool, args, expected]] of steps.entries()) {
      faux.setResponses(calling(tool, args));
      await agent.submit(INPUT(`step ${index}`), `in-${index}`);
      const events = await collect(agent, settledFor(`in-${index}`));
      const results = events.filter((event) => event.body.kind === "tool_result");
      expect((results.at(-1)!.body as { content: string }).content).toContain(expected);
    }
    await agent.close();
    await made.cleanup();
  }, 120_000);

  it("runs a command once and still delivers its result when the backend restarts during it", async () => {
    const { provider, faux, factory } = world();
    const made = await homeContext();
    faux.setResponses(calling("computer_run", { command: "echo started >> count.txt; sleep 2; echo finished >> count.txt; echo done-output" }));
    const first = factory(made.context);
    await first.open();
    await first.submit(INPUT("run it"), "in-1");
    // Wait until the command is under way on the computer, then lose the backend.
    const workspace = async () => join([...provider.volumes.values()][0] ?? "", "workspace", "count.txt");
    const deadline = Date.now() + 60_000;
    while (!(await readFile(await workspace(), "utf8").catch(() => "")).includes("started")) {
      if (Date.now() > deadline) throw new Error("the command never started");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await first.close();

    // A new backend process: the same Home, the same machine. pi resumes the tool, which attaches to its job.
    faux.setResponses(calling("computer_run", { command: "echo started >> count.txt; sleep 2; echo finished >> count.txt; echo done-output" }));
    const second = factory(made.context);
    await second.open();
    const events = await collect(second, settledFor("in-1"));
    const result = events.find((event) => event.body.kind === "tool_result")!.body as { content: string };
    expect(result.content).toContain("done-output");
    expect(result.content).toContain("[exit code 0]");
    expect((await readFile(await workspace(), "utf8")).trim().split("\n")).toEqual(["started", "finished"]);
    await second.close();
    await made.cleanup();
  }, 180_000);

  it("stops the command by its id when the turn is stopped", async () => {
    const { provider, faux, factory } = world();
    const made = await homeContext();
    faux.setResponses(calling("computer_run", { command: "echo go >> flag.txt; sleep 60; echo late >> flag.txt" }));
    const agent = factory(made.context);
    await agent.open();
    await agent.submit(INPUT("run it"), "in-1");
    const flag = async () => join([...provider.volumes.values()][0] ?? "", "workspace", "flag.txt");
    const deadline = Date.now() + 60_000;
    while (!(await readFile(await flag(), "utf8").catch(() => "")).includes("go")) {
      if (Date.now() > deadline) throw new Error("the command never started");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await agent.interrupt("stop-1")).toMatchObject({ applied: true });
    const events = await collect(agent, settledFor("in-1"));
    expect(events.at(-1)!.body).toMatchObject({ outcome: "interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await readFile(await flag(), "utf8")).not.toContain("late");
    await agent.close();
    await made.cleanup();
  }, 180_000);
});
