import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { createMockBackend, refusal } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

let backend: ReturnType<typeof createMockBackend>;
let home: string;

beforeEach(() => {
  backend = createMockBackend();
  home = makeHome();
  seedCliAuth(home);
});
afterEach(() => {
  backend.stop();
  rmSync(home, { recursive: true, force: true });
});

const cronRoutine = {
  id: "t1", taskType: "summarize_sessions", title: "Summarize coding sessions", routineDescription: "d",
  scheduleDescription: "Daily at 03:00 (UTC)", timezone: "UTC", cron: "0 3 * * *", intervalSeconds: null,
  enabled: true, nextRunAt: "2026-10-06T03:00:00.000Z", lastCheckedAt: null,
};
const intervalRoutine = {
  ...cronRoutine, id: "t2", title: "Sync Slack", scheduleDescription: "Every hour", cron: null,
  intervalSeconds: 3600, enabled: false, nextRunAt: null,
};

describe("draft routines list", () => {
  test("human mode prints title, schedule, cron, state and next run", async () => {
    backend.state.routinesResponse = () => Response.json({ routines: [cronRoutine, intervalRoutine], canEdit: true });
    const result = await runCli(["routines", "list"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Summarize coding sessions");
    expect(result.stdout).toContain("Daily at 03:00 (UTC)");
    expect(result.stdout).toContain("0 3 * * *");
    expect(result.stdout).toContain("2026-10-06T03:00:00.000Z");
    expect(result.stdout).toContain("disabled");
    expect(result.stdout).toContain("none scheduled");
  });

  test("JSON mode prints { routines } with schema_version", async () => {
    backend.state.routinesResponse = () => Response.json({ routines: [cronRoutine], canEdit: true });
    const result = await runCli(["routines", "list", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, routines: [cronRoutine] });
  });

  test("empty list reports no routines found", async () => {
    const result = await runCli(["routines", "list"], { home, apiUrl: backend.url });
    expect(result.stdout).toBe("No routines found.");
  });

  test("unexpected argument is invalid usage, exit 2", async () => {
    const result = await runCli(["routines", "list", "extra"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("no_workspace surfaces onboarding guidance", async () => {
    backend.state.whoamiResponse = () => Response.json({ organization_id: null, primary_team_id: null, workspace_id: null, onboarding_completed_at: null });
    const result = await runCli(["routines", "list", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "no_workspace" });
  });

  test("not signed in points to draft auth login", async () => {
    const bareHome = makeHome();
    try {
      const result = await runCli(["routines", "list", "--json"], { home: bareHome, apiUrl: backend.url, timeoutMs: 5_000 });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ code: "not_authenticated", action: "draft auth login" });
    } finally {
      rmSync(bareHome, { recursive: true, force: true });
    }
  });

  test("backend failure reports a retryable error", async () => {
    backend.state.routinesResponse = () => Response.json({ error: "schedules_read_failed" }, { status: 500 });
    const result = await runCli(["routines", "list", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "request_failed" });
  });
});

describe("draft routines create, update, run and delete", () => {
  test("create sends the schedule as a nested object", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.create"] = (input) => { seen = input; return { id: "t3", title: "Digest" }; };
    const result = await runCli([
      "routines", "create", "--title", "Digest", "--prompt", "Summarize the day", "--harness", "claude",
      "--preset", "daily", "--time", "09:00", "--timezone", "UTC", "--notify", "--on", "fireflies.meeting_summarized",
    ], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({
      title: "Digest",
      prompt: "Summarize the day",
      harness: "claude",
      model: null,
      schedule: { preset: "daily", time: "09:00", timezone: "UTC" },
      canNotify: true,
      events: ["fireflies.meeting_summarized"],
    });
  });

  test("update sends a flat patch, and --no-post sends postChannels null", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { id: "t1" }; };
    const result = await runCli(["routines", "update", "t1", "--time", "10:30", "--no-post"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: "t1", patch: { time: "10:30", postChannels: null } });
  });

  test("create without a required flag is a usage error, exit 2", async () => {
    const result = await runCli(["routines", "create", "--title", "Digest", "--prompt", "x", "--harness", "claude"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: draft routines create");
  });

  test("update with nothing to change is a usage error, exit 2", async () => {
    const result = await runCli(["routines", "update", "t1"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("run prints the started message", async () => {
    backend.state.toolOutputs["routines.run"] = () => ({ outcome: { status: "started" } });
    const result = await runCli(["routines", "run", "t1"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Started a run of t1.");
  });

  test("a refusal from the tool is reported as its code, exit 1", async () => {
    backend.state.toolOutputs["routines.delete"] = () => refusal("not_permitted", "Only the creator or an admin can delete this routine.");
    const result = await runCli(["routines", "delete", "t1", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "not_permitted" });
  });

  test("show reports a missing routine, exit 1", async () => {
    backend.state.routinesResponse = () => Response.json({ routines: [cronRoutine], canEdit: true });
    const result = await runCli(["routines", "show", "nope"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Routine not found: nope");
  });
});
