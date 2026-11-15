import type { GithubPullRequestWebhookPayload, GithubPushWebhookPayload } from "../ingestion/github/normalize";
import type { LinearWebhookPayload } from "../ingestion/linear/normalize";

/** The ids, links and refs an agent needs to act on an event, taken from the provider's payload. */
export type EventFact = { label: string; value: string };

const MAX_COMMITS = 20;
const MAX_LINE = 120;

const line = (text: string) => {
  const first = text.split("\n")[0]!.trim();
  return first.length > MAX_LINE ? `${first.slice(0, MAX_LINE - 1)}…` : first;
};
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);
const obj = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);
const facts = (entries: Array<[string, string | number | undefined | null]>): EventFact[] =>
  entries.flatMap(([label, value]) => (value === undefined || value === null || value === "" ? [] : [{ label, value: String(value) }]));

// Payloads are typed from GitHub's docs, but a fact is never worth failing a webhook over, so fields are read defensively.
export function githubPullRequestFacts(payload: GithubPullRequestWebhookPayload): EventFact[] {
  const pr = payload.pull_request;
  const size = pr.changed_files !== undefined ? `${pr.changed_files} files, +${pr.additions ?? 0} −${pr.deletions ?? 0}` : undefined;
  return facts([
    ["Repository", payload.repository.full_name],
    ["Pull request", `#${pr.number}`],
    ["URL", pr.html_url],
    ["Author", pr.user?.login],
    ["Branches", pr.base?.ref && pr.head?.ref ? `${pr.base.ref} ← ${pr.head.ref}` : undefined],
    ["Head commit", pr.head?.sha],
    ["Base commit", pr.base?.sha],
    ["Size", size],
    ["Merged at", pr.merged_at],
    ["Merge commit", pr.merged ? pr.merge_commit_sha : undefined],
  ]);
}

/** A push can hold thousands of commits, so only the newest are listed; the compare link covers the rest. */
export function githubPushFacts(payload: GithubPushWebhookPayload): EventFact[] {
  const commits = payload.commits.slice(-MAX_COMMITS);
  const files = (commit: GithubPushWebhookPayload["commits"][number]) =>
    [...(commit.added ?? []), ...(commit.removed ?? []), ...(commit.modified ?? [])].length;
  const list = commits.map((commit) => {
    const changed = commit.added || commit.removed || commit.modified ? `, ${files(commit)} files` : "";
    return `${commit.id.slice(0, 7)} ${line(commit.message)} (${commit.author.username ?? commit.author.name}${changed})`;
  });
  const hidden = payload.commits.length - commits.length;
  return facts([
    ["Repository", payload.repository.full_name],
    ["Branch", payload.ref.replace(/^refs\/heads\//, "")],
    ["Compare", payload.compare],
    ["Before", payload.before],
    ["After", payload.after],
    ["Commits", `${payload.commits.length}${hidden > 0 ? ` (newest ${commits.length} below)` : ""}\n  ${list.join("\n  ")}`],
  ]);
}

export function linearIssueFacts(payload: LinearWebhookPayload): EventFact[] {
  const data = payload.data;
  const labels = Array.isArray(data.labels) ? data.labels.map((label) => str(obj(label)?.name)).filter(Boolean).join(", ") : undefined;
  return facts([
    ["Issue", str(data.identifier)],
    ["URL", str(data.url) ?? payload.url],
    ["Team", str(obj(data.team)?.name) ?? str(obj(data.team)?.key)],
    ["State", str(obj(data.state)?.name)],
    ["Assignee", str(obj(data.assignee)?.name)],
    ["Priority", str(data.priorityLabel)],
    ["Labels", labels],
    ["Linear issue id", str(data.id)],
  ]);
}

export const meetingFacts = (provider: "Granola note id" | "Fireflies meeting id", id: string): EventFact[] => facts([[provider, id]]);
