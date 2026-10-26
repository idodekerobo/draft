import { GUI_PATH } from "../../exec";

export const TMUX_SOCKET = "draft";
const PANE_COLUMNS = 200;
const PANE_ROWS = 50;

export const tmuxPath = () => `${process.env.HOME}/.draft/bin/tmux`;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function buildClaudeCommand(claudeBin: string, nativeSessionId: string, model: string | null): string {
  const args = ["--session-id", nativeSessionId, ...(model ? ["--model", model] : [])];
  return [shellQuote(claudeBin), ...args.map(shellQuote)].join(" ");
}

export function tmuxSessionName(sessionId: string): string {
  return `draft-${sessionId.slice(0, 8)}`;
}

async function runTmux(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn([tmuxPath(), "-L", TMUX_SOCKET, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: GUI_PATH } });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { ok: (await proc.exited) === 0, stdout, stderr };
}

export interface LaunchOptions {
  tmuxSession: string;
  folderPath: string;
  claudeBin: string;
  nativeSessionId: string;
  model: string | null;
}

/** Starts Claude in a detached tmux pane in the folder. */
export async function launchClaudeInTmux(options: LaunchOptions): Promise<void> {
  const result = await runTmux([
    "new-session", "-d",
    "-s", options.tmuxSession,
    "-x", String(PANE_COLUMNS), "-y", String(PANE_ROWS),
    "-c", options.folderPath,
    "-e", `PATH=${GUI_PATH}:${process.env.HOME}/.local/bin`,
    buildClaudeCommand(options.claudeBin, options.nativeSessionId, options.model),
  ]);
  if (!result.ok) throw new Error(`tmux_launch_failed: ${result.stderr.trim()}`);
}

export async function paneIsAlive(tmuxSession: string): Promise<boolean> {
  return (await runTmux(["has-session", "-t", tmuxSession])).ok;
}
