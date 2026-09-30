import type { TeamSessionRepo, TeamSessionReposState } from "../types";
import type { ToolStatus } from "./registry";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "2h ago", "3d ago", then a short date. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
    const last = `last session ${formatRelativeTime(repo.last_upload_at, now)}`;
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
