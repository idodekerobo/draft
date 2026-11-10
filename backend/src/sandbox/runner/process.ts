import type { HarnessCommand } from "draft-core/harnesses/types";
import type { RunnerManifest } from "draft-core/run-manifest";
import { runnerFaceFor } from "./faces";
import { runnerLog } from "./log";

export function harnessCommand(manifest: RunnerManifest, prompt: string, schemaText: string | null, env: NodeJS.ProcessEnv): HarnessCommand {
  return runnerFaceFor(manifest.harness).command(manifest, prompt, schemaText, env);
}

/** Anything the harness needs on disk before it starts. For Codex that is its home: the login and its config. */
export function prepareHarness(manifest: RunnerManifest, env: NodeJS.ProcessEnv): void {
  runnerFaceFor(manifest.harness).prepare(manifest, env);
}

async function stopChild(child: ReturnType<typeof import("node:child_process")["spawn"]>): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export interface HarnessRun {
  manifest: RunnerManifest;
  prompt: string;
  schemaText: string | null;
  runId: string;
  timeoutMs: number;
  onStdout: (chunk: Buffer, stop: () => void) => void;
  onStderr: (text: string) => void;
  /** Runs every `everyMs` while the harness runs. */
  tick?: { everyMs: number; run: () => void };
}

/** Starts the harness as the agent user, hands its output to the caller, and stops it on the timeout. */
export async function runHarness(input: HarnessRun): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null }; timedOut: boolean }> {
  const { spawn } = await import("node:child_process");
  const command = harnessCommand(input.manifest, input.prompt, input.schemaText, process.env);
  const envArgs = Object.entries(command.env).map(([key, value]) => `${key}=${value}`);
  const [program, ...args] = command.argv;
  const child = spawn("gosu", ["agent", "env", "-i", ...envArgs, program!, ...args], {
    cwd: command.cwd,
    detached: true,
    stdio: [command.stdin !== null ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (command.stdin !== null) {
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(command.stdin);
  }
  const face = runnerFaceFor(input.manifest.harness);
  runnerLog(face.logNames.started, {
    run_id: input.runId,
    ...face.startedFields(input.manifest),
    draft_tools: input.manifest.tools.draftMcpUrl !== null,
    output: input.manifest.output.kind,
    timeout_ms: input.timeoutMs,
  });

  child.stdout?.on("data", (chunk: Buffer) => input.onStdout(chunk, () => void stopChild(child)));
  child.stderr?.on("data", (chunk: Buffer) => input.onStderr(chunk.toString("utf8")));
  const ticker = input.tick ? setInterval(input.tick.run, input.tick.everyMs) : null;

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void stopChild(child);
  }, input.timeoutMs);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timeout);
  if (ticker) clearInterval(ticker);
  await stopChild(child);
  return { exit, timedOut };
}
