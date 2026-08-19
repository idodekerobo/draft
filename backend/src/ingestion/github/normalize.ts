import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertSourceItem } from "../upsert-source-item";
import { insertEvent } from "../../events/insert-event";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Every action whose result touches content_markdown (state, labels, draft
// status) -- not just the "obvious" lifecycle actions.
export const PR_ACTIONS_TO_INGEST = new Set([
  "opened",
  "edited",
  "synchronize",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "ready_for_review",
  "converted_to_draft",
]);

export interface GithubPullRequestWebhookPayload {
  action: string;
  pull_request: {
    node_id: string;
    number: number;
    title: string;
    body: string | null;
    state: string;
    draft: boolean;
    updated_at: string;
    html_url: string;
    user: { login: string };
    base: { ref: string };
    head: { ref: string };
    labels: Array<{ name: string }>;
  };
  repository: { full_name: string };
}

export interface GithubPushWebhookPayload {
  ref: string;
  repository: { full_name: string; default_branch: string };
  commits: Array<{
    id: string;
    message: string;
    url: string;
    timestamp: string;
    author: { name: string; username?: string };
  }>;
}

function buildPullRequestMarkdown(
  pr: GithubPullRequestWebhookPayload["pull_request"],
  repoFullName: string,
): string {
  const meta = [
    `**Repo:** ${repoFullName}`,
    `**Author:** ${pr.user.login}`,
    `**State:** ${pr.draft ? "draft" : pr.state}`,
    `**Branch:** ${pr.base.ref} ← ${pr.head.ref}`,
  ];
  if (pr.labels.length > 0) meta.push(`**Labels:** ${pr.labels.map((l) => l.name).join(", ")}`);

  return [
    `# PR #${pr.number} — ${pr.title}`,
    meta.join("\n"),
    pr.body ? `## Description\n\n${pr.body}` : undefined,
  ]
    .filter((section): section is string => !!section)
    .join("\n\n");
}

function buildCommitMarkdown(
  commit: GithubPushWebhookPayload["commits"][number],
  repoFullName: string,
  branch: string,
): string {
  const author = commit.author.username ?? commit.author.name;
  return [
    `# Commit ${commit.id.slice(0, 7)} on ${branch}`,
    `**Repo:** ${repoFullName}`,
    `**Author:** ${author}`,
    `**URL:** ${commit.url}`,
    commit.message,
  ].join("\n\n");
}

export async function ingestGithubPullRequestEvent(
  connection: { id: string; workspace_id: string },
  payload: GithubPullRequestWebhookPayload,
  client?: SupabaseClient,
): Promise<{ sourceItemId: string } | { skipped: true }> {
  if (!PR_ACTIONS_TO_INGEST.has(payload.action)) return { skipped: true };

  const db = client ?? (await import("../../db/client")).serviceClient;
  const externalId = payload.pull_request.node_id;
  const externalVersion = payload.pull_request.updated_at;

  // GitHub doesn't guarantee delivery order/dedup; skip a redelivered or
  // out-of-order payload rather than letting it supersede newer content.
  const { data: existing, error: lookupError } = await db
    .from("source_items")
    .select("external_version")
    .eq("source_connection_id", connection.id)
    .eq("external_id", externalId)
    .eq("lifecycle_status", "ready")
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing && Date.parse(existing.external_version as string) >= Date.parse(externalVersion)) {
    return { skipped: true };
  }

  const contentMarkdown = buildPullRequestMarkdown(payload.pull_request, payload.repository.full_name);
  const contentHash = sha256(contentMarkdown);

  const result = await upsertSourceItem(db, {
    workspace_id: connection.workspace_id,
    source_connection_id: connection.id,
    item_type: "provider_event",
    external_id: externalId,
    external_version: externalVersion,
    occurred_at: externalVersion,
    content_markdown: contentMarkdown,
    content_hash: contentHash,
    metadata_json: {
      github_event: "pull_request",
      github_action: payload.action,
      github_url: payload.pull_request.html_url,
    },
    sanitized_raw_json: payload.pull_request,
  });

  await insertEvent(db, connection.workspace_id, {
    event_type: "source_items_added",
    source_connection_id: connection.id,
    summary: `PR #${payload.pull_request.number} ${payload.action}: ${payload.pull_request.title}`,
  });

  return { sourceItemId: result.item.id };
}

export async function ingestGithubPushEvent(
  connection: { id: string; workspace_id: string },
  payload: GithubPushWebhookPayload,
  client?: SupabaseClient,
): Promise<{ sourceItemIds: string[] } | { skipped: true }> {
  const defaultBranchRef = `refs/heads/${payload.repository.default_branch}`;
  if (payload.ref !== defaultBranchRef) return { skipped: true };

  const db = client ?? (await import("../../db/client")).serviceClient;
  const branch = payload.repository.default_branch;
  const sourceItemIds: string[] = [];

  for (const commit of payload.commits) {
    const contentMarkdown = buildCommitMarkdown(commit, payload.repository.full_name, branch);
    const contentHash = sha256(contentMarkdown);
    // Commit SHAs are immutable, so external_version === external_id --
    // insert-once, no supersession concept for this item type.
    const result = await upsertSourceItem(db, {
      workspace_id: connection.workspace_id,
      source_connection_id: connection.id,
      item_type: "provider_event",
      external_id: commit.id,
      external_version: commit.id,
      occurred_at: commit.timestamp,
      content_markdown: contentMarkdown,
      content_hash: contentHash,
      metadata_json: {
        github_event: "push",
        github_branch: branch,
        github_url: commit.url,
      },
      sanitized_raw_json: commit,
    });
    sourceItemIds.push(result.item.id);
  }

  if (sourceItemIds.length > 0) {
    await insertEvent(db, connection.workspace_id, {
      event_type: "source_items_added",
      source_connection_id: connection.id,
      summary: `${sourceItemIds.length} commit(s) pushed to ${branch}`,
    });
  }

  return { sourceItemIds };
}
