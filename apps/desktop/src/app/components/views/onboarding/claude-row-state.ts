export type ClaudeRunner = { installed: boolean; auth: "signed_in" | "signed_out" | "unknown" } | null;

export interface ClaudeRowState {
  description: string;
  action: "install" | "sign_in" | null;
}

/** What the Claude Code row says and offers. `null` means the check has not finished. */
export function claudeRowState(runner: ClaudeRunner, signInOpened: boolean): ClaudeRowState {
  if (!runner) return { description: "Checking…", action: null };
  if (!runner.installed) return { description: "Claude Code is not installed on this computer.", action: "install" };
  if (runner.auth === "signed_out") {
    return {
      description: signInOpened ? "Finish signing in in the Terminal window, then come back here." : "Installed, but not signed in.",
      action: "sign_in",
    };
  }
  if (runner.auth === "signed_in") return { description: "Ready. Start Claude Code sessions from the Sessions tab.", action: null };
  return { description: "Installed. You can start Claude Code sessions.", action: null };
}
