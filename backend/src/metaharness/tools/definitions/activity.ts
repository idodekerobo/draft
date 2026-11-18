import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { defineTool, refuse } from "../tool-registry";
import { requireUser } from "./shared";

export function createActivityTools(client: SupabaseClient) {
  const list = defineTool({
    name: "activity.list", mcp: true, allowedOrigins: ["person"],
    input: z.object({ cursor: z.string().max(200).optional().describe("The nextCursor of the previous page, for older runs.") }),
    description: "What the workspace's agents have run, newest first, 50 at a time: routine runs, context updates, session summaries and interactive sessions, with status, timing and result. Pass nextCursor back as cursor for older runs. The first page also lists upcoming: one-time routines that have not run yet, soonest first, with who set each one (upcomingError true means that list failed to load). For one routine's runs, use routines.runs.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "activity.list");
      const { listActivity, parseCursor } = await import("../../../activity/service");
      const before = parseCursor(input.cursor);
      if (before === "invalid") return refuse("invalid_cursor", "That cursor isn't one this tool returned. Pass nextCursor from the previous page.");
      return { status: "ok", output: await listActivity(client, user.workspaceId, before, user.userId) };
    },
  });
  return [list];
}
