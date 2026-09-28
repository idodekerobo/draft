// desktop/src/exec.ts — GUI-safe subprocess wrapper
//
// macOS GUI apps (launched from Finder/Dock) inherit a stripped PATH that
// excludes /usr/local/bin, /opt/homebrew/bin, ~/.local/bin, etc.
// GUI_PATH is a broader fallback that covers common system binary locations.
//
// For user-installed tools (claude, codex), do NOT rely on PATH or shell
// resolution. Use findRunnerBin() in index.ts which checks existsSync on
// known installation paths — works regardless of how the user's shell is
// configured and without spawning any subprocesses.
//
// Import capture from HERE (not from draft-core/exec) in all desktop main-process code.

import { capture as _capture, GUI_PATH } from "draft-core/exec";
export type { CaptureResult } from "draft-core/exec";
export { GUI_PATH } from "draft-core/exec";

export function capture(
  cmd: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
): ReturnType<typeof _capture> {
  return _capture(cmd, {
    ...opts,
    env: { PATH: GUI_PATH, ...opts?.env },
  });
}
