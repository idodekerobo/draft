import { parseCliVersion } from "draft-core/harnesses";
import { capture } from "../../../exec";

export type CodexAuth = "signed_in" | "signed_out" | "unknown";

/** Reads the output of `codex login status`. An output we cannot read is "unknown", which never blocks a start. */
export function parseCodexAuth(output: string): CodexAuth {
  if (/not logged in/i.test(output)) return "signed_out";
  return /logged in/i.test(output) ? "signed_in" : "unknown";
}

export async function readCodexAuth(codexBin: string): Promise<CodexAuth> {
  try {
    const result = await capture([codexBin, "login", "status"], { timeoutMs: 8000 });
    return parseCodexAuth(`${result.stdout}\n${result.stderr}`);
  } catch {
    return "unknown";
  }
}

export async function readCodexVersion(codexBin: string): Promise<string | null> {
  try {
    const result = await capture([codexBin, "--version"], { timeoutMs: 5000 });
    return result.exitCode === 0 ? parseCliVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

export const CODEX_MISSING_MESSAGE = "Codex is not installed on this computer. Install it from developers.openai.com/codex, then try again.";
export const CODEX_SIGNED_OUT_MESSAGE = "Codex is not signed in. Run codex in a terminal, sign in, then try again.";
