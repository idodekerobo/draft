import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createMockBackend, invalidInput, refusal } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";
import { waitForRun } from "../commands/routines.ts";
import type { RoutineRun, ToolCallResult } from "../cloud-client.ts";

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

const ROUTINE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const agentRoutine = {
  id: ROUTINE_ID, taskType: "agent_routine", title: "Summarize sessions", routineDescription: "d",
  enabled: true, scheduleDescription: "Daily at 03:00 (UTC)", preset: "daily", time: "03:00", weekday: null,
  timezone: "UTC", cron: "0 3 * * *", nextRunAt: "2026-10-06T03:00:00.000Z", canEdit: true, updatedByName: "Ada",
  lastRun: null,
  agent: {
    prompt: "Line one\nLine two", harness: "claude", model: null, events: ["github.push"], canNotify: true,
    postChannels: "joined", github: { repos: ["acme/app"], access: "read" }, createdByName: "Ada",
    missingConnections: ["github"],
    lastRun: { id: RUN_ID, status: "completed", startedBy: { type: "schedule" }, startedAt: "2026-10-05T03:00:00.000Z", endedAt: "2026-10-05T03:02:00.000Z", result: "Summarized 4 sessions" },
  },
};

const builtInRoutine = {
  ...agentRoutine, id: "33333333-3333-4333-8333-333333333333", taskType: "synthesize_workspace", title: "Build context",
  enabled: false, scheduleDescription: "Every hour", nextRunAt: null, agent: null, updatedByName: null,
};

describe("draft routines list", () => {
  test("human mode prints the agent, schedule, triggers, access, warnings and last run, but not the prompt", async () => {
    backend.state.toolOutputs["routines.list"] = () => ({ routines: [agentRoutine, builtInRoutine] });
    const result = await runCli(["routines", "list"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Summarize sessions");
    expect(result.stdout).toContain("— enabled");
    expect(result.stdout).toContain(`id: ${ROUTINE_ID}`);
    expect(result.stdout).toContain("agent: claude, default model");
    expect(result.stdout).toContain("when: Daily at 03:00 (UTC)");
    expect(result.stdout).toContain("triggers: github.push");
    expect(result.stdout).toContain("Slack posting: any channel Draft's bot is in");
    expect(result.stdout).toContain("Messages teammates: yes");
    expect(result.stdout).toContain("GitHub: acme/app (read)");
    expect(result.stdout).toContain("missing connection");
    expect(result.stdout).toContain("draft integrations connect github");
    expect(result.stdout).toContain("next run: 2026-10-06T03:00:00.000Z");
    expect(result.stdout).toContain("last run: 2026-10-05T03:00:00.000Z  completed: Summarized 4 sessions");
    expect(result.stdout).not.toContain("Line one");
    expect(result.stdout).toContain("Build context");
    expect(result.stdout).toContain("— disabled");
    expect(result.stdout).toContain("built-in routine (synthesize_workspace)");
  });

  test("JSON mode prints the tool's output unchanged, with schema_version", async () => {
    backend.state.toolOutputs["routines.list"] = () => ({ routines: [agentRoutine] });
    const result = await runCli(["routines", "list", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, routines: [agentRoutine] });
  });

  test("with an id, prints the full prompt, created by and updated by", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.list"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "list", ROUTINE_ID], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID });
    expect(result.stdout).toContain("created by: Ada");
    expect(result.stdout).toContain("updated by: Ada");
    expect(result.stdout).toContain("    Line one\n    Line two");
  });

  test("the list switches map to the routines.list filter", async () => {
    const seen: unknown[] = [];
    backend.state.toolOutputs["routines.list"] = (input) => { seen.push(input); return { routines: [] }; };
    await runCli(["routines", "list", "--once", "--upcoming"], { home, apiUrl: backend.url });
    await runCli(["routines", "list", "--fired", "--mine"], { home, apiUrl: backend.url });
    await runCli(["routines", "list", "--mine"], { home, apiUrl: backend.url });
    expect(seen).toEqual([
      { kind: "once", status: "upcoming" },
      { kind: "once", status: "fired", createdBy: "me" },
      { createdBy: "me" },
    ]);
  });

  test("conflicting list filters, or a filter with an id, are usage errors, exit 2", async () => {
    const cases: string[][] = [
      ["routines", "list", "--upcoming", "--fired"],
      ["routines", "list", ROUTINE_ID, "--once"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
    }
  });

  test("a one-shot shows when it runs, or when it fired, and a routine an agent made says so", async () => {
    const upcoming = { ...agentRoutine, id: "55555555-5555-4555-8555-555555555555", title: "Check PR", kind: "once", runAt: "2026-12-01T14:00:00.000Z", firedAt: null, madeByAgent: true };
    const fired = { ...upcoming, id: "66666666-6666-4666-8666-666666666666", title: "Old check", runAt: "2026-11-01T14:00:00.000Z", firedAt: "2026-11-01T14:00:03.000Z", madeByAgent: false };
    backend.state.toolOutputs["routines.list"] = () => ({ routines: [upcoming, fired] });
    const result = await runCli(["routines", "list", "--once"], { home, apiUrl: backend.url, env: { TZ: "UTC" } });
    const local = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "UTC" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Check PR");
    expect(result.stdout).toContain("— enabled (made by an agent)");
    expect(result.stdout).toContain(`when: Once · ${local("2026-12-01T14:00:00.000Z")}`);
    expect(result.stdout).toContain(`when: Fired ${local("2026-11-01T14:00:03.000Z")}`);
    expect(result.stdout).toContain("Old check\u001b[0m — enabled\n");
  });

  test("empty list reports no routines found", async () => {
    backend.state.toolOutputs["routines.list"] = () => ({ routines: [] });
    const result = await runCli(["routines", "list"], { home, apiUrl: backend.url });
    expect(result.stdout).toBe("No routines found.");
  });

  test("a missing routine is reported by the tool's refusal, exit 1", async () => {
    backend.state.toolOutputs["routines.list"] = () => refusal("not_found", "Routine not found.");
    const result = await runCli(["routines", "list", ROUTINE_ID], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Routine not found.");
  });

  test("show is a hidden alias for list with an id", async () => {
    backend.state.toolOutputs["routines.list"] = () => ({ routine: agentRoutine });
    const result = await runCli(["routines", "show", ROUTINE_ID], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Summarize sessions");
    const usageError = await runCli(["routines", "show"], { home, apiUrl: backend.url });
    expect(usageError.exitCode).toBe(2);
  });

  test("unexpected extra argument is invalid usage, exit 2", async () => {
    const result = await runCli(["routines", "list", ROUTINE_ID, "extra"], { home, apiUrl: backend.url });
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

describe("draft routines options", () => {
  const options = {
    triggers: [
      { event: "github.push", provider: "github", label: "Commits land on the default branch", connected: false },
      { event: "fireflies.meeting_summarized", provider: "fireflies", label: "A Fireflies meeting is summarized", connected: true },
    ],
    schedule: {
      presets: [{ preset: "daily", meaning: "Every day at `time`" }], weekdays: ["sun", "mon"], time: "HH:MM", onSchedule: "false runs it only on triggers",
    },
    agents: [{ harness: "claude", status: "connected", models: [{ model: "opus", label: "Opus" }] }],
    access: { slackChannels: [{ id: "C1", name: "eng" }], githubRepos: ["acme/app"] },
    notes: "A routine runs as the person who created it.",
  };

  test("human mode groups triggers by provider and shows connection state, channels and repos", async () => {
    backend.state.toolOutputs["routines.options"] = () => options;
    const result = await runCli(["routines", "options"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(not connected)");
    expect(result.stdout).toContain("github.push");
    expect(result.stdout).toContain("fireflies.meeting_summarized");
    expect(result.stdout).toContain("daily  Every day at `time`");
    expect(result.stdout).toContain("claude (connected)");
    expect(result.stdout).toContain("opus (Opus)");
    expect(result.stdout).toContain("#eng");
    expect(result.stdout).toContain("acme/app");
  });

  test("JSON mode prints the tool's output unchanged", async () => {
    backend.state.toolOutputs["routines.options"] = () => options;
    const result = await runCli(["routines", "options", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, ...options });
  });
});

describe("draft routines create", () => {
  test("sends the flags as the create input and prints the saved routine", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.create"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli([
      "routines", "create", "--title", "Digest", "--prompt", "Summarize the day", "--harness", "claude",
      "--preset", "daily", "--time", "09:00", "--timezone", "UTC", "--notify",
      "--on", "fireflies.meeting_summarized,github.push", "--post-channels", "#general,#eng",
      "--github", "acme/app,acme/web", "--github-access", "write",
    ], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({
      title: "Digest",
      prompt: "Summarize the day",
      harness: "claude",
      model: null,
      when: { schedule: { preset: "daily", time: "09:00", timezone: "UTC" }, events: ["fireflies.meeting_summarized", "github.push"] },
      canNotify: true,
      postChannels: ["#general", "#eng"],
      github: { repos: ["acme/app", "acme/web"], access: "write" },
    });
    expect(result.stdout).toContain("Created routine.");
    expect(result.stdout).toContain("Summarize sessions");
  });

  test("--in sends a one-shot when with no preset, and --at sends its time", async () => {
    const seen: Record<string, unknown>[] = [];
    backend.state.toolOutputs["routines.create"] = (input) => { seen.push(input); return { routine: agentRoutine }; };
    const inResult = await runCli(["routines", "create", "--title", "Check PR", "--prompt", "Review it", "--harness", "claude", "--in", "2h"], { home, apiUrl: backend.url });
    const atResult = await runCli(["routines", "create", "--title", "Check PR", "--prompt", "Review it", "--harness", "claude", "--at", "2026-12-01T09:00:00-05:00"], { home, apiUrl: backend.url });
    expect(inResult.exitCode).toBe(0);
    expect(atResult.exitCode).toBe(0);
    expect(seen[0]).toMatchObject({ when: { in: "2h" } });
    expect(seen[0]).not.toHaveProperty("preset");
    expect(seen[0]).not.toHaveProperty("schedule");
    expect(seen[1]).toMatchObject({ when: { at: "2026-12-01T09:00:00-05:00" } });
  });

  test("--on alone sends a rule with no schedule, so it runs only on its triggers", async () => {
    let seen: Record<string, unknown> | undefined;
    backend.state.toolOutputs["routines.create"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "create", "--title", "Triage", "--prompt", "Triage", "--harness", "claude", "--on", "linear.issue_created"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toMatchObject({ when: { schedule: null, events: ["linear.issue_created"] } });
  });

  test("--no-schedule sends schedule null with its triggers, and --disabled sends enabled false", async () => {
    let seen: Record<string, unknown> | undefined;
    backend.state.toolOutputs["routines.create"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli([
      "routines", "create", "--title", "Review", "--prompt", "Review PRs", "--harness", "codex",
      "--no-schedule", "--disabled", "--on", "github.pull_request_opened", "--json",
    ], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toMatchObject({ when: { schedule: null, events: ["github.pull_request_opened"] }, enabled: false });
    expect(seen).not.toHaveProperty("onSchedule");
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, routine: agentRoutine });
  });

  test("--prompt-file reads the prompt from a file", async () => {
    const promptPath = join(home, "prompt.md");
    writeFileSync(promptPath, "Write the weekly digest.");
    let seen: Record<string, unknown> | undefined;
    backend.state.toolOutputs["routines.create"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli([
      "routines", "create", "--title", "Digest", "--prompt-file", promptPath, "--harness", "claude", "--preset", "weekly", "--weekday", "fri",
    ], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toMatchObject({ prompt: "Write the weekly digest.", when: { schedule: { preset: "weekly", weekday: "fri" } } });
  });

  test("a refusal from the tool prints its message and exits 1", async () => {
    backend.state.toolOutputs["routines.create"] = () => refusal("too_far_ahead", "A routine can be set at most 365 days ahead. You asked for 2028-01-01T09:00:00.000Z.");
    const result = await runCli(["routines", "create", "--title", "Far", "--prompt", "Later", "--harness", "claude", "--at", "2028-01-01T09:00:00Z"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("A routine can be set at most 365 days ahead. You asked for 2028-01-01T09:00:00.000Z.");
  });

  test("input the tool rejects prints the issues it names and exits 1, not a generic error", async () => {
    backend.state.toolOutputs["routines.create"] = () => invalidInput("when: Invalid input");
    const result = await runCli(["routines", "create", "--title", "T", "--prompt", "P", "--harness", "claude", "--in", "2h", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "invalid_input", message: "when: Invalid input" });
  });

  test("a required flag that is missing is a usage error, exit 2", async () => {
    const result = await runCli(["routines", "create", "--title", "Digest", "--prompt", "x", "--harness", "claude"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: draft routines create");
  });

  test("bad trigger, repo, harness or conflicting flags are usage errors, exit 2", async () => {
    const base = ["routines", "create", "--title", "T", "--prompt", "P", "--harness", "claude", "--preset", "daily"];
    const cases: [string[], string][] = [
      [[...base, "--on", "nope.event"], "unknown trigger"],
      [[...base, "--github", "not-a-repo"], "owner/repo"],
      [[...base, "--github-access", "write"], "--github-access needs --github"],
      [["routines", "create", "--title", "T", "--prompt", "P", "--harness", "gemini", "--preset", "daily"], "--harness must be one of"],
      [[...base, "--no-post"], "unknown flag"],
    ];
    for (const [args, message] of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });

  test("a when that mixes one-shot and rule flags, or has no when at all, is a usage error, exit 2", async () => {
    const base = ["routines", "create", "--title", "T", "--prompt", "P", "--harness", "claude"];
    const cases: [string[], string][] = [
      [[...base, "--in", "2h", "--preset", "daily"], "--in runs once"],
      [[...base, "--at", "2026-12-01T09:00:00Z", "--on", "github.push"], "--at runs once"],
      [[...base, "--in", "2h", "--at", "2026-12-01T09:00:00Z"], "give --in or --at, not both"],
      [[...base, "--in", "2x"], "--in needs a number"],
      [[...base, "--at", "2026-12-01T09:00:00"], "--at needs an ISO time with an offset"],
      [[...base, "--time", "10:00", "--on", "github.push"], "--time, --weekday and --timezone need --preset"],
      [[...base, "--no-schedule", "--preset", "daily"], "--no-schedule can't be combined"],
      [base, "usage: draft routines create"],
    ];
    for (const [args, message] of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });

  test("a missing connection refusal names the integration to connect", async () => {
    backend.state.toolOutputs["routines.create"] = () => refusal("linear_not_connected", "linear is not connected.");
    const result = await runCli([
      "routines", "create", "--title", "T", "--prompt", "P", "--harness", "claude", "--preset", "daily", "--on", "linear.issue_created",
    ], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("linear is not connected.");
    expect(result.stderr).toContain("Connect it with: draft integrations connect linear");
  });
});

describe("draft routines update", () => {
  test("a schedule flag reads the routine's current schedule and sends the whole schedule, and --no-post sends postChannels null", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.list"] = () => ({ routine: agentRoutine });
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--time", "10:30", "--no-post"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, patch: { when: { schedule: { preset: "daily", time: "10:30", timezone: "UTC" } }, postChannels: null } });
    expect(result.stdout).toContain("Updated routine.");
  });

  test("--preset replaces the current preset and keeps the time it does not pass", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.list"] = () => ({ routine: agentRoutine });
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--preset", "weekly", "--weekday", "fri"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, patch: { when: { schedule: { preset: "weekly", time: "03:00", weekday: "fri", timezone: "UTC" } } } });
  });

  test("a schedule change to a custom routine needs --preset, and sends nothing", async () => {
    let updated = false;
    backend.state.toolOutputs["routines.list"] = () => ({ routine: { ...agentRoutine, preset: "custom", time: null } });
    backend.state.toolOutputs["routines.update"] = () => { updated = true; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--time", "10:30"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Pass --preset to set one.");
    expect(updated).toBe(false);
  });

  test("a failed read of the current schedule stops the update, prints the reason and exits 1", async () => {
    let updated = false;
    backend.state.toolOutputs["routines.list"] = () => refusal("not_found", "Routine not found.");
    backend.state.toolOutputs["routines.update"] = () => { updated = true; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--time", "10:30"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Routine not found.");
    expect(updated).toBe(false);
  });

  test("--in and --at reschedule a one-shot with no read of the schedule", async () => {
    const requested: string[] = [];
    let seen: unknown;
    backend.state.toolOutputs["routines.list"] = () => { requested.push("list"); return { routine: agentRoutine }; };
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--in", "1d"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, patch: { when: { in: "1d" } } });
    expect(requested).toEqual([]);
  });

  test("--no-schedule sends schedule null, keeps the trigger change, and --enable sends enabled true", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    await runCli(["routines", "update", ROUTINE_ID, "--no-schedule", "--on", "github.push", "--enable"], { home, apiUrl: backend.url });
    expect(seen).toEqual({ taskId: ROUTINE_ID, patch: { when: { schedule: null, events: ["github.push"] }, enabled: true } });
  });

  test("switches map to patch fields: no-github, no-triggers, schedule and disable", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.list"] = () => ({ routine: agentRoutine });
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--no-github", "--no-triggers", "--schedule", "--disable", "--no-notify"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({
      taskId: ROUTINE_ID,
      patch: { when: { schedule: { preset: "daily", time: "03:00", timezone: "UTC" }, events: [] }, github: null, enabled: false, canNotify: false },
    });
  });

  test("a one-shot and a rule flag together are a usage error, exit 2", async () => {
    const result = await runCli(["routines", "update", ROUTINE_ID, "--in", "2h", "--no-triggers"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--in runs once");
  });

  test("conflicting or empty updates are usage errors, exit 2", async () => {
    const cases: string[][] = [
      ["routines", "update", ROUTINE_ID],
      ["routines", "update", ROUTINE_ID, "--no-triggers", "--on", "github.push"],
      ["routines", "update", ROUTINE_ID, "--schedule", "--no-schedule"],
      ["routines", "update", ROUTINE_ID, "--github", "acme/app", "--no-github"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
    }
  });

  test("a refusal in JSON mode keeps the code and the action", async () => {
    backend.state.toolOutputs["routines.update"] = () => refusal("github_not_connected", "github is not connected.");
    const result = await runCli(["routines", "update", ROUTINE_ID, "--no-triggers", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "github_not_connected", action: "draft integrations connect github" });
  });
});

describe("draft routines delete", () => {
  test("deletes by id and prints a confirmation", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.delete"] = (input) => { seen = input; return { deleted: true }; };
    const result = await runCli(["routines", "delete", ROUTINE_ID], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID });
    expect(result.stdout).toBe(`Deleted routine ${ROUTINE_ID}.`);
  });

  test("a refusal from the tool is reported as its code, exit 1", async () => {
    backend.state.toolOutputs["routines.delete"] = () => refusal("not_permitted", "Only the creator or an admin can delete this routine.");
    const result = await runCli(["routines", "delete", ROUTINE_ID, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "not_permitted" });
  });
});

describe("draft routines run and runs", () => {
  test("run prints the run id and how to check it", async () => {
    backend.state.toolOutputs["routines.run"] = () => ({ runId: RUN_ID, outcome: { status: "started" } });
    const result = await runCli(["routines", "run", ROUTINE_ID], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Started run ${RUN_ID} of ${ROUTINE_ID}.`);
    expect(result.stdout).toContain(`draft routines runs ${ROUTINE_ID} --run-id ${RUN_ID}`);
  });

  test("run says a queued run starts when the current one ends, and exits 0 without waiting", async () => {
    backend.state.toolOutputs["routines.run"] = () => ({ runId: null, queued: true, message: "Queued. It runs when the current run ends." });
    backend.state.requests.length = 0;
    const result = await runCli(["routines", "run", ROUTINE_ID, "--wait"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Queued: runs when the current run ends.");
    expect(backend.state.requests.some((request) => request.url.includes("routines.runs"))).toBe(false);
  });

  test("run --json prints a queued answer as JSON", async () => {
    backend.state.toolOutputs["routines.run"] = () => ({ runId: null, queued: true, message: "Queued. It runs when the current run ends." });
    const result = await runCli(["routines", "run", ROUTINE_ID, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ runId: null, queued: true });
  });

  test("run --wait prints the final status and result, and exits 0 when completed", async () => {
    backend.state.toolOutputs["routines.run"] = () => ({ runId: RUN_ID, outcome: { status: "started" } });
    backend.state.toolOutputs["routines.runs"] = () => ({ run: { id: RUN_ID, status: "completed", startedBy: { type: "run_now" }, startedAt: "t", endedAt: "t", result: "All done" } });
    const result = await runCli(["routines", "run", ROUTINE_ID, "--wait"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Run ${RUN_ID}: completed`);
    expect(result.stdout).toContain("All done");
  });

  test("run --wait --json prints the final run and exits 1 when it failed", async () => {
    backend.state.toolOutputs["routines.run"] = () => ({ runId: RUN_ID, outcome: { status: "started" } });
    backend.state.toolOutputs["routines.runs"] = () => ({ run: { id: RUN_ID, status: "failed", startedBy: { type: "run_now" }, startedAt: "t", endedAt: "t", result: "boom" } });
    const result = await runCli(["routines", "run", ROUTINE_ID, "--wait", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 1, run: { status: "failed", result: "boom" } });
  });

  test("runs lists recent runs with what started them", async () => {
    backend.state.toolOutputs["routines.runs"] = () => ({
      runs: [
        { id: RUN_ID, status: "completed", startedBy: { type: "schedule" }, startedAt: "2026-10-05T03:00:00.000Z", endedAt: null, result: "Summarized 4 sessions" },
        { id: "44444444-4444-4444-8444-444444444444", status: "skipped", startedBy: { type: "event", event: "linear.issue_completed" }, startedAt: "2026-10-04T03:00:00.000Z", endedAt: null, result: null, skipReason: "Source not visible" },
      ],
    });
    const result = await runCli(["routines", "runs", ROUTINE_ID], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${RUN_ID}  completed  Schedule  2026-10-05T03:00:00.000Z`);
    expect(result.stdout).toContain("A Linear issue is completed");
    expect(result.stdout).toContain("Source not visible");
  });

  test("runs --run-id shows one run with its skip reason", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.runs"] = (input) => {
      seen = input;
      return { run: { id: RUN_ID, status: "skipped", startedBy: { type: "run_now" }, startedAt: "t", endedAt: null, result: null, skipReason: "Already ran today" } };
    };
    const result = await runCli(["routines", "runs", ROUTINE_ID, "--run-id", RUN_ID], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, runId: RUN_ID });
    expect(result.stdout).toContain("status: skipped");
    expect(result.stdout).toContain("skipped because: Already ran today");
  });

  test("runs --transcript prints lines and a hint for the next page", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.runs"] = (input) => {
      seen = input;
      return { run: { id: RUN_ID }, transcript: { lines: ["step one", "step two"], nextCursor: 40 } };
    };
    const result = await runCli(["routines", "runs", ROUTINE_ID, "--run-id", RUN_ID, "--transcript", "--cursor", "20"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, runId: RUN_ID, transcript: true, cursor: "20" });
    expect(result.stdout).toContain("step one\nstep two");
    expect(result.stdout).toContain(`More: draft routines runs ${ROUTINE_ID} --run-id ${RUN_ID} --transcript --cursor 40`);
  });

  test("runs pages through older runs with the cursor the last page printed", async () => {
    let seen: unknown;
    const cursor = "2026-11-14T10:00:00.000Z|11111111-1111-4111-8111-111111111111";
    backend.state.toolOutputs["routines.runs"] = (input) => {
      seen = input;
      return { runs: [{ id: RUN_ID, status: "completed", startedBy: { type: "schedule" }, startedAt: "t", endedAt: null, result: "ok" }], nextCursor: cursor };
    };
    const result = await runCli(["routines", "runs", ROUTINE_ID, "--cursor", "previous"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, cursor: "previous" });
    expect(result.stdout).toContain(`Older runs: draft routines runs ${ROUTINE_ID} --cursor '${cursor}'`);
  });

  test("runs flag combinations that need each other are usage errors, exit 2", async () => {
    const transcriptWithoutRun = await runCli(["routines", "runs", ROUTINE_ID, "--transcript"], { home, apiUrl: backend.url });
    expect(transcriptWithoutRun.exitCode).toBe(2);
    const cursorWithoutTranscript = await runCli(["routines", "runs", ROUTINE_ID, "--run-id", RUN_ID, "--cursor", "3"], { home, apiUrl: backend.url });
    expect(cursorWithoutTranscript.exitCode).toBe(2);
  });
});

describe("waitForRun", () => {
  const running: { run: RoutineRun } = { run: { id: RUN_ID, status: "running", startedBy: { type: "run_now" }, startedAt: "t", endedAt: null, result: null } };
  const completed: { run: RoutineRun } = { run: { ...running.run, status: "completed", result: "ok" } };

  test("polls until the run leaves running", async () => {
    const answers = [running, completed];
    let calls = 0;
    const waited = await waitForRun(ROUTINE_ID, RUN_ID, {
      intervalMs: 1,
      readRun: async (): Promise<ToolCallResult> => ({ ok: true, output: answers[calls++] }),
    });
    expect(calls).toBe(2);
    expect(waited).toEqual(completed);
  });

  test("stops with a timeout error when the run is still running at the deadline", async () => {
    const waited = await waitForRun(ROUTINE_ID, RUN_ID, {
      intervalMs: 1,
      timeoutMs: 0,
      readRun: async (): Promise<ToolCallResult> => ({ ok: true, output: running }),
    });
    expect("error" in waited && waited.error.code).toBe("wait_timeout");
  });
});

describe("draft routines help", () => {
  test("routines --help lists one line per command and points to per-command help", async () => {
    const result = await runCli(["routines", "--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    for (const name of ["list", "options", "create", "update", "delete", "run", "runs"]) {
      expect(result.stdout).toContain(`${name}`);
    }
    expect(result.stdout).toContain("draft routines <command> --help");
    expect(result.stdout).not.toContain("draft routines show");
  });

  test("create --help lists its flags and the valid triggers", async () => {
    const result = await runCli(["routines", "create", "--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    for (const flag of ["--prompt-file", "--no-schedule", "--github-access", "--post-channels", "--disabled"]) {
      expect(result.stdout).toContain(flag);
    }
    expect(result.stdout).toContain("fireflies.meeting_summarized");
    expect(result.stdout).toContain("daily, weekdays");
  });

  test("run --help says --wait is CLI-only", async () => {
    const result = await runCli(["routines", "run", "--help"], { home, apiUrl: backend.url });
    expect(result.stdout).toContain("--wait is CLI-only");
  });

  test("routines --help shows one-shots with --in and says they are routines too", async () => {
    const result = await runCli(["routines", "--help"], { home, apiUrl: backend.url });
    expect(result.stdout).toContain("--in 2h");
    expect(result.stdout).toContain("draft routines list --once");
    expect(result.stdout).toContain("Routines: work Draft runs once");
  });

  test("create --help and update --help list --in and --at; list --help lists the filters", async () => {
    const create = await runCli(["routines", "create", "--help"], { home, apiUrl: backend.url });
    const update = await runCli(["routines", "update", "--help"], { home, apiUrl: backend.url });
    const list = await runCli(["routines", "list", "--help"], { home, apiUrl: backend.url });
    for (const flag of ["--in <duration>", "--at <iso-time>"]) {
      expect(create.stdout).toContain(flag);
      expect(update.stdout).toContain(flag);
    }
    expect(update.stdout).toContain("--in / --at reschedule a one-shot");
    for (const flag of ["--once", "--upcoming", "--fired", "--mine"]) expect(list.stdout).toContain(flag);
  });

  test("the top-level help line for routines mentions once", async () => {
    const result = await runCli(["--help"], { home, apiUrl: backend.url });
    expect(result.stdout).toContain("Routines: work Draft runs once, on a schedule, or when something happens");
  });

  test("shell completion offers the one-shot flags", async () => {
    const bash = await runCli(["completion"], { home, apiUrl: backend.url });
    const zsh = await runCli(["completion", "--zsh"], { home, apiUrl: backend.url });
    for (const flag of ["--in", "--at", "--once", "--upcoming", "--fired", "--mine"]) {
      expect(bash.stdout).toContain(flag);
      expect(zsh.stdout).toContain(`'${flag}`);
    }
    expect(zsh.stdout).toContain("list:List routines, including one-shots with --once");
  });
});
