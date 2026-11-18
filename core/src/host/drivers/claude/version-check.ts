import { parseCliVersion } from "../../../harnesses";
import { hostServices } from "../../services";

/** The installed Claude Code version, or null when it cannot be read. */
export async function readClaudeVersion(claudeBin: string): Promise<string | null> {
  const services = hostServices();
  try {
    const result = await services.capture([claudeBin, "--version"], { timeoutMs: 5000 });
    return result.exitCode === 0 ? parseCliVersion(result.stdout) : null;
  } catch {
    return null;
  }
}
