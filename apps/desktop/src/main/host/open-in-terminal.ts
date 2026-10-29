import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { attachCommand, paneIsAlive } from "./launch";

const SCRIPT_DIR = `${process.env.HOME}/.draft/host/attach`;

/** Runs a shell command in the app that opens `.command` files, which is the user's terminal app. */
export async function openCommandInTerminal(name: string, command: string): Promise<{ ok: true } | { ok: false; error: string }> {
  mkdirSync(SCRIPT_DIR, { recursive: true, mode: 0o700 });
  const path = `${SCRIPT_DIR}/${name}.command`;
  writeFileSync(path, `#!/bin/bash\n${command}\n`);
  chmodSync(path, 0o700);

  const proc = Bun.spawn(["open", path], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) return { ok: false, error: "Could not open the terminal." };
  return { ok: true };
}

/** Runs `tmux attach` in the user's terminal app. */
export async function openPaneInTerminal(tmuxSession: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await paneIsAlive(tmuxSession))) return { ok: false, error: "The session has already ended." };
  return openCommandInTerminal(tmuxSession, `exec ${attachCommand(tmuxSession)}`);
}
