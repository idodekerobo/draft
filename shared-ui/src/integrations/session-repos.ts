import type { TeamSessionRepo, TeamSessionReposState } from "../types";
import { relativeTime } from "../relative-time";
import type { ToolStatus } from "./registry";

/** "You, Kai +1": the caller first, then up to `max` names, then a count of the rest. */
export function summarizeContributors(contributors: TeamSessionRepo["contributors"], max = 2): string {
  const ordered = [...contributors].sort((a, b) => Number(b.is_me) - Number(a.is_me));
  const names = ordered.map((c) => (c.is_me ? "You" : c.display));
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

/** Second line of a repo row. */
export function repoMeta(repo: TeamSessionRepo, now: number = Date.now()): string {
  if (repo.last_upload_at) {
    const people = summarizeContributors(repo.contributors);
    const last = `last session ${relativeTime(repo.last_upload_at, { now })}`;
    return people ? `${people} · ${last}` : last;
  }
  const enabler = repo.created_by ? ` · enabled by ${repo.created_by.is_me ? "you" : repo.created_by.display}` : "";
  return `No sessions yet${enabler}`;
}

/** Status for the "Coding sessions" row: the workspace switch, with a repo count once loaded. */
export function codingSessionsStatus(connected: boolean, repos: TeamSessionReposState): ToolStatus {
  if (!connected) return { state: "disconnected" };
  if (repos.status !== "ready") return { state: "connected", detail: "On" };
  const count = repos.repos.length;
  if (count === 0) return { state: "connected", detail: "On, no repos yet" };
  return { state: "connected", detail: count === 1 ? "1 repo capturing" : `${count} repos capturing` };
}
