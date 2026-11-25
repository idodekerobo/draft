import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ACT_REFUSALS, actOnNotification, listNotifications, type NotificationAction } from "../../../home/notifications";
import { getNeedsYou } from "../../../home/needs-you";
import { defineTool, refuse } from "../tool-registry";
import { requireUser } from "./shared";

const notificationId = z.string().uuid().describe("The notification id, from notifications.list or home.needs_you.");

/** The Home tools. They read and change one person's own notifications, so only a signed-in person may call them. */
export function createHomeTools(client: SupabaseClient) {
  // TODO: let a run call these for its owner once routines can be private to that owner.
  const needsYou = defineTool({
    name: "home.needs_you",
    mcp: true,
    allowedOrigins: ["person"],
    description:
      "What needs the caller now, newest first: open approvals, questions an agent asked them, their open to-dos and other action notifications, " +
      "and failed sends from routines they own. Returns the total count and the rows. Reading changes nothing.",
    input: z.object({}),
    handler: async ({ caller }) => {
      const user = requireUser(caller, "home.needs_you");
      return { status: "ok", output: await getNeedsYou(client, user.workspaceId, user.userId), summary: "read what needs you" };
    },
  });

  const list = defineTool({
    name: "notifications.list",
    mcp: true,
    allowedOrigins: ["person"],
    description: "The caller's own notifications, newest first, up to 100. Filter to those that need action, or by state (open, done, not_mine, retracted).",
    input: z.object({
      needsAction: z.boolean().optional().describe("True for only the notifications that need the caller to act."),
      state: z.enum(["open", "done", "not_mine", "retracted"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "notifications.list");
      return { status: "ok", output: { notifications: await listNotifications(client, user.workspaceId, user.userId, input) } };
    },
  });

  const act = (name: "notifications.done" | "notifications.not_mine" | "notifications.undo", action: NotificationAction, description: string) =>
    defineTool({
      name,
      mcp: true,
      allowedOrigins: ["person"],
      description,
      input: z.object({ notificationId }),
      auditArguments: (input) => ({ notificationId: input.notificationId }),
      handler: async ({ caller, input }) => {
        const user = requireUser(caller, name);
        const result = await actOnNotification(client, user.workspaceId, user.userId, input.notificationId, action);
        if (!result.ok) return refuse(result.code, ACT_REFUSALS[result.code]);
        return { status: "ok", output: { state: result.state, changed: result.changed, reassignNotificationId: result.reassignNotificationId }, summary: `${action}: ${result.state}` };
      },
    });

  return [
    needsYou,
    list,
    act("notifications.done", "done", "Mark one of the caller's notifications done. Repeating it changes nothing."),
    act("notifications.not_mine", "not_mine", "Say a routed to-do is not the caller's. It closes the to-do and asks the routine owner to reassign it. Only to-dos have this action."),
    act("notifications.undo", "undo", "Take back done or not mine, which reopens the notification. It is refused once a later action was taken, such as the owner acting on the reassign card."),
  ];
}
