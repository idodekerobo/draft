import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { attachCommand, paneIsAlive } from "./launch";

const SCRIPT_DIR = `${process.env.HOME}/.draft/host/attach`;

/** Runs `tmux attach` in the app that opens `.command` files, which is the user's terminal app. */
export async function openPaneInTerminal(tmuxSession: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await paneIsAlive(tmuxSession))) return { ok: false, error: "The session has already ended." };

  mkdirSync(SCRIPT_DIR, { recursive: true });
  const path = `${SCRIPT_DIR}/${tmuxSession}.command`;
  writeFileSync(path, `#!/bin/bash\nexec ${attachCommand(tmuxSession)}\n`);
  chmodSync(path, 0o755);

  const proc = Bun.spawn(["open", path], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) return { ok: false, error: "Could not open the terminal." };
  return { ok: true };
}
