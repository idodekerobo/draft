import { randomUUID } from "node:crypto";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { EmbeddedAgentContext } from "../../embedded-agent/adapter";
import { ComputerError } from "./client";
import type { HomeComputer } from "./computer";

const TAIL_CHARS = 20_000;
const POLL_MS = 500;
const TOUCH_MS = 30_000;
const text = (value: string, isError = false) => ({ output: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) });
/** Waits, and ends early when the call is cancelled. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
const describe = (error: unknown) => (error instanceof ComputerError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));

/**
 * Home's computer as tools. Each call checks that this process still owns Home before it touches the machine, and the machine
 * is made only on the first call. `computer_run` saves its job id before it asks the computer, and the computer treats a known
 * id as "attach", so after a backend restart the same call finds its job and collects its output once: the tool is safe to
 * replay. If the machine's files were replaced, or the job's record has no process behind it, the result says the command's
 * outcome is unknown and it is not run again.
 */
export function createComputerTools(input: { computer: () => HomeComputer; context: EmbeddedAgentContext; lifecycle?: { readonly closing: boolean } }): ToolRegistration[] {
  const { context } = input;

  const run = defineTool({
    name: "computer_run",
    description:
      "Run a shell command on your computer: a Linux machine with a persistent workspace folder, git, python and node, and open internet access. " +
      "It runs in the background and you get its output when it ends. Long commands are fine, up to the time limit. Files you create stay between commands and conversations.",
    parameters: obj({ command: str(), cwd: opt(str()), timeoutSeconds: opt(num()) }),
    replay: "safe",
    async execute(args, api, callContext) {
      context.assertOwner();
      const jobId = await api.memo("computer.job", `job-${randomUUID()}`, callContext);
      try {
        const { client, generation } = await input.computer().client();
        // The first call saves which computer the job went to. If that computer's files were replaced, the job is gone.
        const started = await api.memo("computer.generation", generation, callContext);
        if (started !== generation) return text("The computer was replaced while this command was running, so its output is lost. It was not run again. Check the state of the files and decide whether to run it again.", true);
        await client.exec({ id: jobId, command: args.command, cwd: args.cwd, timeoutSeconds: args.timeoutSeconds });

        let from = 0;
        let tail = "";
        let touched = Date.now();
        while (true) {
          // A command that runs for an hour is use, not idleness.
          if (Date.now() - touched > TOUCH_MS) {
            touched = Date.now();
            await input.computer().touch().catch(() => {});
          }
          if (callContext.abortSignal?.aborted) {
            // A stop ends the command. A shutdown leaves it running: the restart attaches to it by its id.
            if (!input.lifecycle?.closing) await client.cancel(jobId).catch(() => {});
            return text("Stopped.", true);
          }
          const page = await client.job(jobId, from);
          if (page.output) {
            api.output(page.output);
            tail = (tail + page.output).slice(-TAIL_CHARS);
          }
          from = page.nextOffset;
          if (page.job.state !== "running" && from >= page.job.outputBytes) {
            const { state, exitCode } = page.job;
            const status = state === "finished" ? `exit code ${exitCode}` : state === "timeout" ? "stopped: it ran past its time limit" : state === "cancelled" ? "cancelled" : "lost: the computer restarted while it ran, so its result is unknown. It was not run again.";
            return text(`${tail}${tail && !tail.endsWith("\n") ? "\n" : ""}[${status}]`, state !== "finished" || exitCode !== 0);
          }
          if (page.job.state === "running" || from < page.job.outputBytes) await sleep(page.job.state === "running" ? POLL_MS : 0, callContext.abortSignal);
        }
      } catch (error) {
        return text(`The computer could not run this: ${describe(error)}`, true);
      }
    },
    // Stop asks the computer to end the job by its id. The id is saved, so a rerun after a restart stops the same job.
    async cancel(_args, api, callContext) {
      const jobId = await api.memo<string>("computer.job", callContext);
      if (!jobId) return;
      const { client } = await input.computer().client();
      await client.cancel(jobId).catch(() => {});
    },
  });

  const read = defineTool({
    name: "computer_read_file",
    description: "Read a text file from your computer's workspace folder.",
    parameters: obj({ path: str() }),
    replay: "safe",
    async execute(args) {
      context.assertOwner();
      try {
        const { client } = await input.computer().client();
        const file = await client.readFile(args.path);
        return text(file.truncated ? `${file.content}\n[cut: the file is ${file.size} bytes]` : file.content);
      } catch (error) {
        return text(`Could not read it: ${describe(error)}`, true);
      }
    },
  });

  const write = defineTool({
    name: "computer_write_file",
    description: "Write a text file in your computer's workspace folder, replacing it if it exists. Folders are made as needed.",
    parameters: obj({ path: str(), content: str() }),
    replay: "safe",
    async execute(args, api, callContext) {
      context.assertOwner();
      // One key for the call, so a rerun after a crash does not write twice, and a later change is not undone.
      const key = await api.memo("computer.write", `write-${randomUUID()}`, callContext);
      try {
        const { client } = await input.computer().client();
        const result = await client.writeFile(args.path, args.content, key);
        return text(result.replayed ? "Already written." : `Wrote ${args.path}.`);
      } catch (error) {
        return text(`Could not write it: ${describe(error)}`, true);
      }
    },
  });

  const list = defineTool({
    name: "computer_list",
    description: "List a folder in your computer's workspace folder. An empty path is the workspace folder itself.",
    parameters: obj({ path: opt(str()) }),
    replay: "safe",
    async execute(args) {
      context.assertOwner();
      try {
        const { client } = await input.computer().client();
        const { entries, truncated } = await client.list(args.path ?? "");
        return text(`${entries.map((entry) => `${entry.type === "dir" ? "d" : entry.type === "link" ? "l" : "-"} ${entry.name}${entry.type === "file" ? ` (${entry.size} bytes)` : ""}`).join("\n") || "(empty)"}${truncated ? "\n[cut: more entries]" : ""}`);
      } catch (error) {
        return text(`Could not list it: ${describe(error)}`, true);
      }
    },
  });

  const tools = [run, read, write, list] as unknown as ToolRegistration[];
  return tools;
}

/** The computer's tools as one extension, for a registry that installs extensions. */
export const computerExtension = (tools: ToolRegistration[]) => defineExtension({ name: "draft-computer", tools });
