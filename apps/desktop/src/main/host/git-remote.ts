import { capture } from "../../exec";

/** The folder's `origin` URL, or null when it is not a git repo or has no origin. */
export async function gitRemote(folderPath: string): Promise<string | null> {
  try {
    const result = await capture(["git", "-C", folderPath, "remote", "get-url", "origin"], { timeoutMs: 3000 });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}
