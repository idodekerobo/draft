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

/** The visible screen of the pane, with ANSI escapes kept so dim text can be told from typed text. */
export async function capturePane(tmuxSession: string): Promise<string> {
  const result = await runTmux(["capture-pane", "-p", "-e", "-t", tmuxSession]);
  if (!result.ok) throw new Error(`tmux_capture_failed: ${result.stderr.trim()}`);
  return result.stdout;
}

const PASTE_BUFFER = "draft-input";

/** Pastes as a bracketed paste, so line breaks stay in the composer and nothing runs as a key press. */
export async function pasteIntoPane(tmuxSession: string, text: string): Promise<void> {
  const set = await runTmux(["set-buffer", "-b", PASTE_BUFFER, "--", text]);
  if (!set.ok) throw new Error(`tmux_paste_failed: ${set.stderr.trim()}`);
  const paste = await runTmux(["paste-buffer", "-b", PASTE_BUFFER, "-p", "-d", "-t", tmuxSession]);
  if (!paste.ok) throw new Error(`tmux_paste_failed: ${paste.stderr.trim()}`);
}

export async function pressEnter(tmuxSession: string): Promise<void> {
  const result = await runTmux(["send-keys", "-t", tmuxSession, "Enter"]);
  if (!result.ok) throw new Error(`tmux_keys_failed: ${result.stderr.trim()}`);
}

/** Attaching a smaller terminal shrinks the window and it stays small. With no client attached, restore the size. */
export async function restorePaneSize(tmuxSession: string): Promise<void> {
  const info = await runTmux(["display-message", "-p", "-t", tmuxSession, "#{session_attached} #{window_width} #{window_height}"]);
  if (!info.ok) return;
  const [attached, width, height] = info.stdout.trim().split(" ").map(Number);
  if (attached === 0 && (width !== PANE_COLUMNS || height !== PANE_ROWS)) {
    await runTmux(["resize-window", "-t", tmuxSession, "-x", String(PANE_COLUMNS), "-y", String(PANE_ROWS)]);
  }
}

export const attachCommand = (tmuxSession: string) => `${shellQuote(tmuxPath())} -L ${TMUX_SOCKET} attach -t ${shellQuote(tmuxSession)}`;
