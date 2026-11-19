const KEY = "draft.recentRepos";
const MAX = 8;

/** Repositories this person started cloud sessions from, newest first. Empty when storage is unavailable. */
export function loadRecentRepos(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((repo): repo is string => typeof repo === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Puts a repository first. A storage failure only loses the convenience, so it is not reported. */
export function rememberRepo(repo: string, storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): string[] {
  const next = [repo, ...loadRecentRepos(storage).filter((entry) => entry !== repo)].slice(0, MAX);
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows and full storage refuse writes; the list is a convenience only.
  }
  return next;
}
