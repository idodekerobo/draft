import { capture } from "../../exec";

export type ClaudeAuth = "signed_in" | "signed_out" | "unknown";

/** Reads the output of `claude auth status`. An output we cannot read is "unknown", which never blocks a start. */
export function parseClaudeAuth(output: string): ClaudeAuth {
  try {
    const loggedIn = (JSON.parse(output) as { loggedIn?: unknown }).loggedIn;
    return loggedIn === true ? "signed_in" : loggedIn === false ? "signed_out" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function readClaudeAuth(claudeBin: string): Promise<ClaudeAuth> {
  try {
    const result = await capture([claudeBin, "auth", "status"], { timeoutMs: 8000 });
    return parseClaudeAuth(result.stdout);
  } catch {
    return "unknown";
  }
}

export const CLAUDE_MISSING_MESSAGE = "Claude Code is not installed on this computer. Install it from claude.com/claude-code, then try again.";
export const CLAUDE_SIGNED_OUT_MESSAGE = "Claude Code is not signed in. Run claude in a terminal, sign in, then try again.";
