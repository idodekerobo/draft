import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { createMockBackend, refusal } from "./helpers/mock-backend.ts";
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
      schedule: { preset: "daily", time: "09:00", timezone: "UTC" },
      canNotify: true,
      postChannels: ["#general", "#eng"],
      github: { repos: ["acme/app", "acme/web"], access: "write" },
      events: ["fireflies.meeting_summarized", "github.push"],
    });
    expect(result.stdout).toContain("Created routine.");
    expect(result.stdout).toContain("Summarize sessions");
  });

  test("--no-schedule defaults the preset to daily and sends onSchedule false; --disabled sends enabled false", async () => {
    let seen: Record<string, unknown> | undefined;
    backend.state.toolOutputs["routines.create"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli([
      "routines", "create", "--title", "Review", "--prompt", "Review PRs", "--harness", "codex",
      "--no-schedule", "--disabled", "--on", "github.pull_request_opened", "--json",
    ], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toMatchObject({ schedule: { preset: "daily" }, onSchedule: false, enabled: false, events: ["github.pull_request_opened"] });
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
    expect(seen).toMatchObject({ prompt: "Write the weekly digest.", schedule: { preset: "weekly", weekday: "fri" } });
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
  test("sends a flat patch, and --no-post sends postChannels null", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--time", "10:30", "--no-post"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, patch: { time: "10:30", postChannels: null } });
    expect(result.stdout).toContain("Updated routine.");
  });

  test("switches map to patch fields: no-github, no-triggers, schedule and disable", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    const result = await runCli(["routines", "update", ROUTINE_ID, "--no-github", "--no-triggers", "--schedule", "--disable", "--no-notify"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ taskId: ROUTINE_ID, patch: { github: null, events: [], onSchedule: true, enabled: false, canNotify: false } });
  });

  test("--no-schedule sends onSchedule false and keeps the preset", async () => {
    let seen: unknown;
    backend.state.toolOutputs["routines.update"] = (input) => { seen = input; return { routine: agentRoutine }; };
    await runCli(["routines", "update", ROUTINE_ID, "--no-schedule", "--on", "github.push", "--enable"], { home, apiUrl: backend.url });
    expect(seen).toEqual({ taskId: ROUTINE_ID, patch: { onSchedule: false, events: ["github.push"], enabled: true } });
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
});
