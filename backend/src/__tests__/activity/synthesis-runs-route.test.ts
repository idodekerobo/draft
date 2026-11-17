import { describe, expect, it, mock } from "bun:test";
import { activityClient } from "./activity-fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const TEAMMATE = "33333333-3333-4333-8333-333333333333";

let signedIn = TEAMMATE;
mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, caller: { userId: string }) => unknown) => (request: Request) => handler(request, { userId: signedIn }),
}));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => null }));

const at = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
const tables = {
  agent_runs: [{
    id: "run-1", workspace_id: WS, kind: "interactive", session_id: "session-1", scheduled_task_id: null,
    status: "succeeded", outcome: null, trigger: null, summary: null, started_at: null, completed_at: null, created_at: at(1),
  }],
  scheduled_tasks: [
    { id: "task-shared", workspace_id: WS, schedule_kind: "cron", config_json: { title: "Team digest" }, created_via: "run", created_by_run_id: "run-1", visibility: "shared", created_by_user_id: ME, created_at: at(2) },
    { id: "task-mine", workspace_id: WS, schedule_kind: "cron", config_json: { title: "My digest" }, created_via: "run", created_by_run_id: "run-1", visibility: "private", created_by_user_id: ME, created_at: at(3) },
  ],
};
mock.module("../../db/client", () => ({ serviceClient: activityClient(tables) }));

const { GET } = await import("../../routes/synthesis-runs");

async function createdTitles(viewerId: string): Promise<string[]> {
  signedIn = viewerId;
  const request = Object.assign(new Request(`http://localhost/workspaces/${WS}/synthesis-runs`), { params: { id: WS } }) as unknown as Parameters<typeof GET>[0];
  const response = await GET(request);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { runs: Array<{ createdRoutines: Array<{ title: string }> }> };
  return body.runs[0]!.createdRoutines.map((created) => created.title);
}

describe("GET /workspaces/:id/synthesis-runs", () => {
  it("shows the caller their own private routines and hides a teammate's", async () => {
    expect(await createdTitles(ME)).toEqual(["Team digest", "My digest"]);
    expect(await createdTitles(TEAMMATE)).toEqual(["Team digest"]);
  });
});
