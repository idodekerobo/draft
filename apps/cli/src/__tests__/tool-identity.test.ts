import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

let home: string;
let server: ReturnType<typeof Bun.serve>;
let seen: Array<{ method: string; path: string; auth: string | null }>;
let respond: (path: string) => Response;

const toolAnswer = () => Response.json({ status: "ok", output: { skills: [{ name: "email-template", description: "Draft emails." }] } });

beforeEach(() => {
  home = makeHome();
  seen = [];
  respond = toolAnswer;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") });
      if (url.pathname === "/whoami") return Response.json({ organization_id: null, primary_team_id: null, workspace_id: "ws-1", onboarding_completed_at: null });
      return respond(url.pathname);
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const skillsList = (env: Record<string, string> = {}) =>
  runCli(["skills", "list"], { home, apiUrl: `http://localhost:${server.port}`, env });

const toolRequests = () => seen.filter((request) => request.path.includes("/tools/"));

describe("which identity a tool call uses", () => {
  test("run credentials call the run route with the run token and need no sign-in", async () => {
    const result = await skillsList({ DRAFT_RUN_ID: "run-1", DRAFT_RUN_TOKEN: "tok-1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("email-template");
    expect(seen).toEqual([{ method: "POST", path: "/runs/run-1/tools/skills.list", auth: "Bearer tok-1" }]);
  });

  test("a signed-in person calls the workspace route with their own token", async () => {
    seedCliAuth(home);
    const result = await skillsList();
    expect(result.exitCode).toBe(0);
    expect(toolRequests()).toEqual([{ method: "POST", path: "/workspaces/ws-1/tools/skills.list", auth: "Bearer seed-at" }]);
  });

  test("run credentials win when a person is also signed in", async () => {
    seedCliAuth(home);
    const result = await skillsList({ DRAFT_RUN_ID: "run-1", DRAFT_RUN_TOKEN: "tok-1" });
    expect(result.exitCode).toBe(0);
    expect(seen.map((request) => request.path)).toEqual(["/runs/run-1/tools/skills.list"]);
  });

  test("neither run credentials nor a sign-in says to sign in", async () => {
    const result = await skillsList();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Not signed in");
    expect(result.stderr).toContain("draft auth login");
    expect(seen).toHaveLength(0);
  });

  test("only one run variable names the missing one and sends nothing", async () => {
    seedCliAuth(home);
    const missingToken = await skillsList({ DRAFT_RUN_ID: "run-1" });
    expect(missingToken.exitCode).not.toBe(0);
    expect(missingToken.stderr).toContain("both be set");
    const missingId = await skillsList({ DRAFT_RUN_TOKEN: "tok-1" });
    expect(missingId.exitCode).not.toBe(0);
    expect(missingId.stderr).toContain("both be set");
    expect(seen).toHaveLength(0);
  });

  test("a refused run token says the run may have finished", async () => {
    respond = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const result = await skillsList({ DRAFT_RUN_ID: "run-1", DRAFT_RUN_TOKEN: "tok-1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("run token was refused");
    expect(result.stderr).toContain("may have finished");
  });

  test("the connections commands say it too, not a generic failure", async () => {
    const partial = await runCli(["connections", "list"], { home, apiUrl: `http://localhost:${server.port}`, env: { DRAFT_RUN_ID: "run-1" } });
    expect(partial.exitCode).toBe(1);
    expect(partial.stderr).toContain("both be set");

    respond = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const refused = await runCli(["connections", "list", "--json"], { home, apiUrl: `http://localhost:${server.port}`, env: { DRAFT_RUN_ID: "run-1", DRAFT_RUN_TOKEN: "tok-1" } });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ status: "error", code: "run_token_refused" });
    expect(JSON.parse(refused.stdout).message).toContain("may have finished");
  });

  test("a tool's own refusal comes through the run route unchanged", async () => {
    respond = () => Response.json({ status: "refused", code: "not_permitted", message: "This run has no skills.list permission." });
    const result = await runCli(["context", "read", "--dimension", "memory", "--period", "today", "--json"], {
      home,
      apiUrl: `http://localhost:${server.port}`,
      env: { DRAFT_RUN_ID: "run-1", DRAFT_RUN_TOKEN: "tok-1" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(seen[0]?.path).toBe("/runs/run-1/tools/context.read");
  });
});
