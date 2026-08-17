import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertSourceItem, type UpsertSourceItemResult } from "../upsert-source-item";
import { insertEvent } from "../../events/insert-event";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Issue/Comment field names confirmed against live payloads; Project/Cycle/ProjectUpdate are unverified.
export type LinearWebhookResourceType = "Issue" | "Comment" | "Project" | "Cycle" | "ProjectUpdate";
export type LinearWebhookAction = "create" | "update" | "remove";

export interface LinearWebhookPayload {
  type: LinearWebhookResourceType;
  action: LinearWebhookAction;
  createdAt?: string;
  data: Record<string, unknown>;
  url?: string;
  organizationId?: string;
  webhookTimestamp?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nested(data: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = data[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function buildIssueMarkdown(data: Record<string, unknown>): string {
  const title = str(data.title) ?? "(untitled issue)";
  const identifier = str(data.identifier);
  const description = str(data.description);
  const state = str(nested(data, "state")?.name);
  const assignee = str(nested(data, "assignee")?.name);
  const priority = str(data.priorityLabel);

  const meta: string[] = [];
  if (state) meta.push(`**State:** ${state}`);
  if (assignee) meta.push(`**Assignee:** ${assignee}`);
  if (priority) meta.push(`**Priority:** ${priority}`);

  return [
    `# ${identifier ? `${identifier} — ${title}` : title}`,
    meta.length > 0 ? meta.join("\n") : undefined,
    description ? `## Description\n\n${description}` : undefined,
  ].filter((section): section is string => !!section).join("\n\n");
}

function buildCommentMarkdown(data: Record<string, unknown>): string {
  const body = str(data.body) ?? "";
  const user = str(nested(data, "user")?.name);
  const issueTitle = str(nested(data, "issue")?.title);

  return [
    `# Comment${issueTitle ? ` on ${issueTitle}` : ""}`,
    user ? `**Author:** ${user}` : undefined,
    body,
  ].filter((section): section is string => !!section).join("\n\n");
}

function buildProjectMarkdown(data: Record<string, unknown>): string {
  const name = str(data.name) ?? "(untitled project)";
  const description = str(data.description) ?? str(data.content);
  const state = str(data.state);

  return [
    `# ${name}`,
    state ? `**State:** ${state}` : undefined,
    description ? `## Description\n\n${description}` : undefined,
  ].filter((section): section is string => !!section).join("\n\n");
}

function buildCycleMarkdown(data: Record<string, unknown>): string {
  const name = str(data.name) ?? `Cycle ${str(data.number) ?? ""}`.trim();
  const startsAt = str(data.startsAt);
  const endsAt = str(data.endsAt);

  return [
    `# ${name}`,
    startsAt && endsAt ? `**Dates:** ${startsAt} – ${endsAt}` : undefined,
  ].filter((section): section is string => !!section).join("\n\n");
}

function buildProjectUpdateMarkdown(data: Record<string, unknown>): string {
  const body = str(data.body) ?? "";
  const health = str(data.health);
  const user = str(nested(data, "user")?.name);
  const projectName = str(nested(data, "project")?.name);

  return [
    `# Project update${projectName ? ` — ${projectName}` : ""}`,
    [
      user ? `**Author:** ${user}` : undefined,
      health ? `**Health:** ${health}` : undefined,
    ].filter((part): part is string => !!part).join(" · ") || undefined,
    body,
  ].filter((section): section is string => !!section).join("\n\n");
}

const MARKDOWN_BUILDERS: Record<LinearWebhookResourceType, (data: Record<string, unknown>) => string> = {
  Issue: buildIssueMarkdown,
  Comment: buildCommentMarkdown,
  Project: buildProjectMarkdown,
  Cycle: buildCycleMarkdown,
  ProjectUpdate: buildProjectUpdateMarkdown,
};

export async function ingestLinearEvent(
  connection: { id: string; workspace_id: string },
  payload: LinearWebhookPayload,
  client?: SupabaseClient,
): Promise<{ sourceItemId: string } | { skipped: true }> {
  const buildMarkdown = MARKDOWN_BUILDERS[payload.type];
  if (!buildMarkdown) return { skipped: true };

  const externalId = str(payload.data.id);
  if (!externalId) return { skipped: true };

  const contentMarkdown = buildMarkdown(payload.data);
  const contentHash = sha256(contentMarkdown);
  const externalVersion = str(payload.data.updatedAt) ?? contentHash;
  const occurredAt = str(payload.data.updatedAt) ?? str(payload.createdAt) ?? new Date().toISOString();

  const db = client ?? (await import("../../db/client")).serviceClient;

  const result: UpsertSourceItemResult = await upsertSourceItem(db, {
    workspace_id: connection.workspace_id,
    source_connection_id: connection.id,
    item_type: "provider_event",
    external_id: externalId,
    external_version: externalVersion,
    occurred_at: occurredAt,
    content_markdown: contentMarkdown,
    content_hash: contentHash,
    metadata_json: {
      linear_resource_type: payload.type,
      linear_action: payload.action,
      linear_url: payload.url ?? null,
    },
    sanitized_raw_json: payload.data,
  });

  await insertEvent(db, connection.workspace_id, {
    event_type: "source_items_added",
    source_connection_id: connection.id,
    summary: str(payload.data.title) ?? str(payload.data.name) ?? `${payload.type} ${payload.action}`,
  });

  return { sourceItemId: result.item.id };
}
