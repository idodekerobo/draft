import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { makeHome, runCli } from "./helpers/cli-runner.ts";

let home: string;
let server: ReturnType<typeof Bun.serve>;
let seen: Array<{ method: string; path: string; auth: string | null; body: string }>;
let respond: (path: string, method: string) => Response;

beforeEach(() => {
  home = makeHome();
  seen = [];
  respond = () => new Response(null, { status: 404 });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body: await req.text() });
      return respond(url.pathname, req.method);
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

const run = (args: string[], env: Record<string, string> = { DRAFT_RUN_ID: "run-1", DRAFT_RUN_TOKEN: "tok-1" }, stdin?: string) =>
  runCli(args, { home, apiUrl: `http://localhost:${server.port}`, env, stdin });

describe("draft tools", () => {
  test("refuses to run outside an agent run", async () => {
    const result = await run(["tools", "list"], {});
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("DRAFT_RUN_ID");
    expect(seen).toHaveLength(0);
  });

  test("lists tools with the run's own token", async () => {
    respond = () => Response.json({ tools: [{ name: "context.read", access: "read", description: "Read context", inputSchema: { type: "object" } }] });
    const result = await run(["tools", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("context.read");
    expect(seen[0]).toMatchObject({ method: "GET", path: "/runs/run-1/tools", auth: "Bearer tok-1" });
  });

  test("lists tools as JSON", async () => {
    const tools = [{ name: "context.read", access: "read", description: "d", inputSchema: {} }];
    respond = () => Response.json({ tools });
    const result = await run(["tools", "list", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, status: "ok", tools });
  });

  test("calls a tool with --args and prints the result", async () => {
    respond = () => Response.json({ status: "ok", output: { documents: [] } });
    const result = await run(["tools", "call", "context.read", "--args", '{"paths":["a.md"]}']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok", output: { documents: [] } });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/runs/run-1/tools/context.read", body: '{"paths":["a.md"]}' });
  });

  test("reads arguments from a file", async () => {
    respond = () => Response.json({ status: "ok", output: {} });
    const file = join(home, "args.json");
    writeFileSync(file, '{"summary":"s"}');
    const result = await run(["tools", "call", "context.write", "--args-file", file]);
    expect(result.exitCode).toBe(0);
    expect(seen[0]!.body).toBe('{"summary":"s"}');
  });

  test("a conflict is an answer, not a failed command", async () => {
    respond = () => Response.json({ status: "conflict", output: { retryable: true } });
    const result = await run(["tools", "call", "context.write", "--args", "{}", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "conflict" });
  });

  test("a denied or invalid call exits 1 and still prints the answer", async () => {
    respond = () => Response.json({ status: "denied", code: "not_permitted", message: "no" }, { status: 403 });
    const result = await run(["tools", "call", "slack.post", "--args", "{}"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not_permitted");
  });

  test("reports a refused token without leaking it", async () => {
    respond = () => new Response(null, { status: 401 });
    const result = await run(["tools", "call", "context.read"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("token was refused");
    expect(result.stderr + result.stdout).not.toContain("tok-1");
  });

  test("needs a tool name", async () => {
    const result = await run(["tools", "call"]);
    expect(result.exitCode).toBe(2);
    expect(seen).toHaveLength(0);
  });
});
