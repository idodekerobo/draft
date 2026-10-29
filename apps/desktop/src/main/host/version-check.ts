import { parseCliVersion } from "draft-core/harnesses";
import { capture } from "../../exec";

/** The installed Claude Code version, or null when it cannot be read. */
export async function readClaudeVersion(claudeBin: string): Promise<string | null> {
  try {
    const result = await capture([claudeBin, "--version"], { timeoutMs: 5000 });
    return result.exitCode === 0 ? parseCliVersion(result.stdout) : null;
  } catch {
    return null;
  }
}
