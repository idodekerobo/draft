import type { SupabaseClient } from "@supabase/supabase-js";
import { captureProductEvent } from "../observability/product-analytics";

export type NotificationAction = "done" | "not_mine" | "undo";
export type NotificationState = "open" | "done" | "not_mine" | "retracted";

export type NotificationView = {
  id: string;
  kind: string;
  subject: string;
  text: string;
  link: string | null;
  needsAction: boolean;
  state: NotificationState;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  actedAt: string | null;
};

type NotificationRow = {
  id: string;
  kind: string;
  subject: string;
  body_text: string;
  link: string | null;
  needs_action: boolean;
  state: NotificationState;
  ref_type: string | null;
  ref_id: string | null;
  created_at: string;
  acted_at: string | null;
};

const COLUMNS = "id, kind, subject, body_text, link, needs_action, state, ref_type, ref_id, created_at, acted_at";

export const toNotificationView = (row: NotificationRow): NotificationView => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  text: row.body_text,
  link: row.link,
  needsAction: row.needs_action,
  state: row.state,
  refType: row.ref_type,
  refId: row.ref_id,
  createdAt: row.created_at,
  actedAt: row.acted_at,
});

/** The person a user is in a workspace, or null when they have no person row. */
export async function personIdForUser(client: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data, error } = await client.from("people").select("id").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

/** The viewer's own notifications, newest first. Only the recipient reads a notification here. */
export async function listNotifications(
  client: SupabaseClient,
  workspaceId: string,
  userId: string,
  options: { needsAction?: boolean; state?: NotificationState; limit?: number } = {},
): Promise<NotificationView[]> {
  const personId = await personIdForUser(client, workspaceId, userId);
  if (!personId) return [];
  let query = client.from("notifications").select(COLUMNS).eq("workspace_id", workspaceId).eq("recipient_person_id", personId);
  if (options.needsAction !== undefined) query = query.eq("needs_action", options.needsAction);
  if (options.state) query = query.eq("state", options.state);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(Math.min(options.limit ?? 50, 100));
  if (error) throw error;
  return ((data ?? []) as NotificationRow[]).map(toNotificationView);
}

export type ActResult =
  | { ok: true; state: NotificationState; changed: boolean; reassignNotificationId: string | null }
  | { ok: false; code: "not_found" | "not_recipient" | "not_actionable" | "already_acted" | "stale_undo" | "invalid_action"; state?: NotificationState };

/** Marks a notification done or not mine, or undoes that. The database changes the state and the history in one transaction. */
export async function actOnNotification(client: SupabaseClient, workspaceId: string, userId: string, notificationId: string, action: NotificationAction): Promise<ActResult> {
  const { data, error } = await client.rpc("act_on_notification", { p_workspace_id: workspaceId, p_notification_id: notificationId, p_actor_user_id: userId, p_action: action });
  if (error) throw error;
  const result = data as { ok: boolean; code?: string; state?: NotificationState; changed?: boolean; reassignNotificationId?: string | null };
  if (!result.ok) return { ok: false, code: result.code as Extract<ActResult, { ok: false }>["code"], state: result.state };
  if (result.changed) {
    const { data: row } = await client.from("notifications").select("kind").eq("id", notificationId).eq("workspace_id", workspaceId).maybeSingle();
    const event = { done: "notification_done", not_mine: "notification_not_mine", undo: "notification_undone" } as const;
    await captureProductEvent(client, event[action], { userId, workspaceId, key: `${notificationId}:${action}:${result.state}:${result.reassignNotificationId ?? ""}:${Date.now()}`, properties: { kind: (row as { kind?: string } | null)?.kind ?? null } });
  }
  return { ok: true, state: result.state as NotificationState, changed: result.changed ?? false, reassignNotificationId: result.reassignNotificationId ?? null };
}

export const ACT_REFUSALS: Record<Extract<ActResult, { ok: false }>["code"], string> = {
  not_found: "No notification with that id in this workspace.",
  not_recipient: "Only the person this notification was sent to can act on it.",
  not_actionable: "This notification has nothing to act on.",
  already_acted: "This notification was already handled another way.",
  stale_undo: "This can no longer be undone, because a later action was taken.",
  invalid_action: "That action is not supported.",
};
