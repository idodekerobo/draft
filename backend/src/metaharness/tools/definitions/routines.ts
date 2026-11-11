import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { defineTool } from "../tool-registry";
import { requireUser } from "./shared";

// Loaded on first use: the service opens the service database client, which a registry built for a test must not need.
const scheduleService = () => import("../../../schedules/service");

/** The routine tools. They need a person: a run has no workspace member to act for. */
export function createRoutineTools(client: SupabaseClient) {
  const routines = defineTool({
    name: "routines.list",
    mcp: true,
    description: "List the routines (scheduled background tasks) in the caller's workspace, with schedule, cron expression, enabled state, and next run.",
    callers: ["user"],
    input: z.object({}),
    handler: async ({ caller }) => {
      const user = requireUser(caller, "routines.list");
      return { status: "ok", output: { routines: await (await scheduleService()).listRoutines(user.workspaceId) } };
    },
  });

  return [routines];
}
