import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "fs";
import { createMockBackend } from "./helpers/mock-backend.ts";
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

const routineRun = {
  id: "r1", kind: "routine", sessionId: "s1", routineId: "t1", routineTitle: "Daily digest", status: "succeeded",
  resultSummary: "Posted in #general", startedAt: "2026-11-14T10:00:00.000Z", completedAt: "2026-11-14T10:00:16.000Z", createdAt: "2026-11-14T10:00:00.000Z",
};

test("activity list shows each run with its result, how to open a routine run, and the cursor for older runs", async () => {
  let seen: unknown;
  backend.state.toolOutputs["activity.list"] = (input) => {
    seen = input;
    return { runs: [routineRun, { ...routineRun, id: "r2", kind: "synthesis", routineId: null, routineTitle: null, sessionId: null, resultSummary: null }], nextCursor: "c-next" };
  };
  const result = await runCli(["activity", "list", "--cursor", "c-prev"], { home, apiUrl: backend.url });
  expect(result.exitCode).toBe(0);
  expect(seen).toEqual({ cursor: "c-prev" });
  expect(result.stdout).toContain("Daily digest · routine (16.0s)");
  expect(result.stdout).toContain("Posted in #general");
  expect(result.stdout).toContain("draft routines runs t1 --run-id s1");
  expect(result.stdout).toContain("Context update");
  expect(result.stdout).toContain("Older runs: draft activity list --cursor 'c-next'");
});

test("activity list --json prints the tool's answer", async () => {
  backend.state.toolOutputs["activity.list"] = () => ({ runs: [routineRun], nextCursor: null });
  const result = await runCli(["activity", "list", "--json"], { home, apiUrl: backend.url });
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ runs: [{ id: "r1" }], nextCursor: null });
});

test("activity --help explains paging", async () => {
  const result = await runCli(["activity", "--help"], { home, apiUrl: backend.url });
  expect(result.stdout).toContain("--cursor <c>");
});
