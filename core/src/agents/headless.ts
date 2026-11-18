// core/src/agents/headless.ts — Claude Code sign-in preflight and CLI output classification

import { join } from "path";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { capture } from "../exec";

const NOT_AUTHENTICATED_ERROR =
  "You're not signed in to Claude Code. Open a terminal, run `claude`, then `/login` to sign in — then retry context setup.";

/**
 * Preflight only — checks whether Claude Code has *ever* logged in, not
 * whether that session is still valid. macOS stores the OAuth token in
 * Keychain; there's no local way to validate it without a network call, and
 * `classifyOutput` already catches expired
 * tokens on the real run. This exists to skip a doomed run entirely for the
 * common "never logged in" case, not to guarantee auth is good.
 */
export async function isClaudeAuthenticated(): Promise<boolean> {
  if (platform() === "darwin") {
    const result = await capture(["security", "find-generic-password", "-s", "Claude Code-credentials"]);
    return result.exitCode === 0;
  }
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}

// Claude Code's `-p` CLI writes auth failures ("Not logged in · Please run
// /login", "Failed to authenticate. API Error: 401 ...") to stdout, not
// stderr — so this must check both. Confirmed from real failure logs where
// stderr was empty and the error text was in stdout.
export function classifyOutput(output: string): string {
  const s = output.toLowerCase();
  if (s.includes("not logged in") || s.includes("failed to authenticate") || s.includes("please run /login") || s.includes("401")) {
    return NOT_AUTHENTICATED_ERROR;
  }
  if (s.includes("auth") || s.includes("login")) return "Your session expired. Sign in and try again.";
  if (s.includes("rate") || s.includes("429")) return "Rate limited. Wait a moment and try again.";
  if (s.includes("token") || s.includes("context length") || s.includes("too long")) return "Too much content to process at once. Try with a smaller folder.";
  if (s.includes("network") || s.includes("connect") || s.includes("econnrefused") || s.includes("dns")) return "Network error. Check your connection and try again.";
  return "Something went wrong. You can retry or set up context manually.";
}
