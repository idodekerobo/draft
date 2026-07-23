// core/src/exec.ts — subprocess wrappers
//
// Used by: draft-cli, draft-desktop (main process)
//
// Two explicit functions, not one:
//   spawn()   — passthrough stdio. Use for: start, stop, logs --follow
//               User sees output live. Ctrl+C works. Returns exitCode only.
//   capture() — buffered stdout/stderr. Use for: doctor, status, publish loop
//               30s default timeout. AbortController-based.

const DEFAULT_TIMEOUT_MS = 30_000;

// Directories where user-installed tools live (npm globals, Homebrew, /usr/local/bin).
// macOS GUI apps inherit a stripped PATH that excludes all of these.
// Pass this as `env: { PATH: GUI_PATH }` in any capture() or Bun.spawn() call
// that needs to find a user-installed binary (claude, codex, etc.).
export const GUI_PATH = `${process.env.HOME ?? ""}/.draft/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`;

/**
 * spawn: passthrough stdio. stdout/stderr stream directly to the terminal.
 * Use when you want the user to see live output (start, stop, logs --follow).
 */
export async function spawn(cmd: string[]): Promise<number> {
  const bin  = cmd[0] ?? "";
  const args = cmd.slice(1);
  const proc = Bun.spawn([bin, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

export interface CaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * capture: buffered stdout/stderr. Use when you need to parse the output
 * (status, doctor, publish loop). Times out after opts.timeoutMs (default 30s).
 *
 * opts.env — additional env vars merged on top of process.env.
 */
export async function capture(
  cmd: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> }
): Promise<CaptureResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin  = cmd[0] ?? "";
  const args = cmd.slice(1);
  const env  = opts?.env
    ? { ...(process.env as Record<string, string>), ...opts.env }
    : undefined;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(env ? { env } : {}),
    });
  } catch (err: unknown) {
    // Binary not found or failed to spawn — treat as non-zero exit
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: "", stderr: msg };
  }

  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<CaptureResult>((resolve) => {
    timerId = setTimeout(() => {
      proc.kill();
      resolve({ exitCode: 124, stdout: "", stderr: `Command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });

  const result = new Promise<CaptureResult>(async (resolve) => {
    const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    resolve({ exitCode, stdout: stdoutBuf.trim(), stderr: stderrBuf.trim() });
  });

  const winner = await Promise.race([result, timeout]);
  clearTimeout(timerId); // cancel the timer if result won — prevents event loop hang
  return winner;
}
