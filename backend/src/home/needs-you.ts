import type { SupabaseClient } from "@supabase/supabase-js";
import { personIdForUser, toNotificationView, type NotificationView } from "./notifications";

export type NeedsYouRow =
  | { kind: "approval"; id: string; sessionId: string; title: string | null; openCount: number; createdAt: string }
  | { kind: "input_request"; id: string; runId: string; question: string; createdAt: string }
  | { kind: "notification"; id: string; notification: NotificationView; createdAt: string }
  | { kind: "connection_attention"; id: string; provider: string; status: string; createdAt: string }
  | { kind: "failed_delivery"; id: string; notificationId: string; subject: string; channel: string; status: string; createdAt: string };

export type NeedsYou = { count: number; rows: NeedsYouRow[]; partial?: boolean };

const MAX_ROWS = 100;
const FAILED_DELIVERY_DAYS = 7;

/**
 * What needs this person now: open approvals on sessions they can see, questions agents asked them, their open
 * to-dos and other action notifications, and failed sends from routines they own. Home sessions of others never appear.
 */
export async function getNeedsYou(client: SupabaseClient, workspaceId: string, userId: string): Promise<NeedsYou> {
  const settled = await Promise.allSettled([
    openApprovals(client, workspaceId, userId),
    openInputRequests(client, workspaceId, userId),
    openNotifications(client, workspaceId, userId),
    connectionsNeedingAttention(client, workspaceId, userId),
    failedDeliveries(client, workspaceId, userId),
  ]);
  // One source failing must not hide the rest. The caller is told the list is partial.
  const failed = settled.filter((result) => result.status === "rejected");
  for (const result of failed) console.error(JSON.stringify({ source: "needs_you", event: "source_failed", error: String((result as PromiseRejectedResult).reason) }));
  if (failed.length === settled.length) throw (failed[0] as PromiseRejectedResult).reason;
  const rows = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { count: rows.length, rows: rows.slice(0, MAX_ROWS), ...(failed.length ? { partial: true } : {}) };
}

async function openApprovals(client: SupabaseClient, workspaceId: string, userId: string): Promise<NeedsYouRow[]> {
  const { data, error } = await client
    .from("sessions")
    .select("id, title, open_approval_count, last_event_at, started_at, owner_user_id, is_home")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .neq("status", "ended")
    .gt("open_approval_count", 0);
  if (error) throw error;
  type Row = { id: string; title: string | null; open_approval_count: number; last_event_at: string | null; started_at: string; owner_user_id: string; is_home: boolean };
  return ((data ?? []) as Row[])
    .filter((row) => !row.is_home || row.owner_user_id === userId)
    .map((row) => ({ kind: "approval", id: row.id, sessionId: row.id, title: row.title, openCount: row.open_approval_count, createdAt: row.last_event_at ?? row.started_at }));
}

async function openInputRequests(client: SupabaseClient, workspaceId: string, userId: string): Promise<NeedsYouRow[]> {
  const { data, error } = await client
    .from("agent_run_input_requests")
    .select("id, agent_run_id, question, created_at, agent_runs!inner(on_behalf_of_user_id)")
    .eq("workspace_id", workspaceId)
    .eq("status", "open")
    .eq("agent_runs.on_behalf_of_user_id", userId);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; agent_run_id: string; question: string; created_at: string }>).map((row) => ({
    kind: "input_request",
    id: row.id,
    runId: row.agent_run_id,
    question: row.question,
    createdAt: row.created_at,
  }));
}

async function openNotifications(client: SupabaseClient, workspaceId: string, userId: string): Promise<NeedsYouRow[]> {
  const personId = await personIdForUser(client, workspaceId, userId);
  if (!personId) return [];
  const { data, error } = await client
    .from("notifications")
    .select("id, kind, subject, body_text, link, needs_action, state, ref_type, ref_id, created_at, acted_at")
    .eq("workspace_id", workspaceId)
    .eq("recipient_person_id", personId)
    .eq("needs_action", true)
    .eq("state", "open")
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  return ((data ?? []) as Parameters<typeof toNotificationView>[0][]).map((row) => ({ kind: "notification", id: row.id, notification: toNotificationView(row), createdAt: row.created_at }));
}

/** The viewer's own connections that stopped working. The row is read from the connection, so it clears when the connection recovers. */
async function connectionsNeedingAttention(client: SupabaseClient, workspaceId: string, userId: string): Promise<NeedsYouRow[]> {
  const { data, error } = await client
    .from("connections")
    .select("id, provider, status, last_error_at, created_at")
    .eq("workspace_id", workspaceId)
    .eq("connected_by_user_id", userId)
    .in("status", ["degraded", "error"]);
  if (error) throw error;
  type Row = { id: string; provider: string; status: string; last_error_at: string | null; created_at: string };
  return ((data ?? []) as Row[]).map((row) => ({ kind: "connection_attention", id: row.id, provider: row.provider, status: row.status, createdAt: row.last_error_at ?? row.created_at }));
}

// TODO: a failed send has no way to be cleared, so it leaves this list after FAILED_DELIVERY_DAYS. Add a dismiss action with safe retry.
async function failedDeliveries(client: SupabaseClient, workspaceId: string, userId: string): Promise<NeedsYouRow[]> {
  const { data: tasks, error: tasksError } = await client.from("scheduled_tasks").select("id").eq("workspace_id", workspaceId).eq("created_by_user_id", userId);
  if (tasksError) throw tasksError;
  const taskIds = ((tasks ?? []) as Array<{ id: string }>).map((task) => task.id);
  if (!taskIds.length) return [];
  const since = new Date(Date.now() - FAILED_DELIVERY_DAYS * 86_400_000).toISOString();
  const { data, error } = await client
    .from("notification_deliveries")
    .select("id, notification_id, channel, status, created_at, notifications!inner(subject, scheduled_task_id)")
    .eq("workspace_id", workspaceId)
    .in("status", ["failed", "bounced", "complained"])
    .in("notifications.scheduled_task_id", taskIds)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  type Row = { id: string; notification_id: string; channel: string; status: string; created_at: string; notifications: { subject: string } | Array<{ subject: string }> };
  return ((data ?? []) as Row[]).map((row) => {
    const joined = Array.isArray(row.notifications) ? row.notifications[0] : row.notifications;
    return { kind: "failed_delivery", id: row.id, notificationId: row.notification_id, subject: joined?.subject ?? "", channel: row.channel, status: row.status, createdAt: row.created_at };
  });
}
