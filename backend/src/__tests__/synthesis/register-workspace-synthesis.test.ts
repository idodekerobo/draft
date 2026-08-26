import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createInitialWorkspaceSynthesis,
  SYNTHESIS_SCHEDULE_CRON,
} from "../../synthesis/register-workspace-synthesis";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function createFakeClient() {
  const upserts: { payload: Record<string, unknown>; onConflict: string }[] = [];
  const client = {
    from: (table: string) => {
      if (table !== "scheduled_tasks") throw new Error(`Unexpected table ${table}`);
      return {
        upsert: (payload: Record<string, unknown>, opts: { onConflict: string }) => {
          upserts.push({ payload, onConflict: opts.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, upserts };
}

describe("createInitialWorkspaceSynthesis", () => {
  it("upserts a cron-scheduled synthesize_workspace task on the workspace conflict target", async () => {
    const { client, upserts } = createFakeClient();

    await createInitialWorkspaceSynthesis({ id: workspaceId }, client);
    await createInitialWorkspaceSynthesis({ id: workspaceId }, client);

    expect(upserts).toHaveLength(2);
    for (const call of upserts) {
      expect(call.onConflict).toBe("workspace_id,task_type,task_key");
      expect(call.payload).toMatchObject({
        workspace_id: workspaceId,
        task_type: "synthesize_workspace",
        task_key: workspaceId,
        schedule_kind: "cron",
        cron_expression: SYNTHESIS_SCHEDULE_CRON,
        interval_seconds: null,
        enabled: true,
      });
      expect(typeof call.payload.next_due_at).toBe("string");
    }
  });
});
