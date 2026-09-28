import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { createMockBackend } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

let backend: ReturnType<typeof createMockBackend>;
let home: string;
let project: string;

beforeEach(() => {
  backend = createMockBackend();
  home = makeHome();
  seedCliAuth(home);
  project = mkdtempSync(join(tmpdir(), "draft-sessions-project-"));
  execSync("git init -q", { cwd: project });
  execSync('git config user.email "dev@example.com"', { cwd: project });
  execSync('git config user.name "Dev Example"', { cwd: project });
});
afterEach(() => {
  backend.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("draft sessions enable", () => {
  test("writes config.json, the hook script, and merges the SessionEnd hook — never commits", async () => {
    const result = await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);

    const configPath = join(project, ".claude", "draft", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config).toMatchObject({
      backendUrl: backend.url,
      workspaceId: "ws-1",
      ingestToken: "draft_sit_cred-1_secret",
      projectId: "project-1",
      allowedProviders: ["claude-code-session"],
      credentialScope: "ingest-only, shared with repo access",
    });
    expect(typeof config.projectKey).toBe("string");
    expect(config.projectKey.length).toBeGreaterThan(0);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const hookScriptPath = join(project, ".claude", "draft", "capture-session.sh");
    expect(existsSync(hookScriptPath)).toBe(true);
    expect(readFileSync(hookScriptPath, "utf8")).toContain("sessions ingest");

    const settingsPath = join(project, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain("capture-session.sh");

    const gitStatus = execSync("git status --porcelain", { cwd: project }).toString();
    expect(gitStatus.trim()).not.toBe(""); // files written but untracked
    const gitLog = execSync("git log --oneline || true", { cwd: project }).toString();
    expect(gitLog.trim()).toBe(""); // never commits (repo has no commits at all)
  });

  test("re-running is idempotent — hookChanged is false the second time", async () => {
    await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    const result = await runCli(["sessions", "enable", "claude-code", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", hookChanged: false });
  });

  test("unsupported agent reports a clear not-yet-supported error", async () => {
    const result = await runCli(["sessions", "enable", "codex", "--dir", project], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not yet supported");
  });

  test("unknown agent is invalid usage, exit 2", async () => {
    const result = await runCli(["sessions", "enable", "notatool", "--dir", project], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("missing directory reports an operational error", async () => {
    const result = await runCli(["sessions", "enable", "claude-code", "--dir", join(project, "nope")], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
  });
});

describe("draft sessions disable", () => {
  test("removes the SessionEnd hook and grace-window-revokes the credential", async () => {
    await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    const result = await runCli(["sessions", "disable", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", hookRemoved: true, revoked: true });

    const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks?.SessionEnd ?? []).toEqual([]);
  });

  test("is a no-op when nothing was enabled", async () => {
    const result = await runCli(["sessions", "disable", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout)).toMatchObject({ hookRemoved: false, revoked: false });
  });
});

describe("draft sessions rotate", () => {
  test("mints a replacement credential and rewrites config.json", async () => {
    await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    const result = await runCli(["sessions", "rotate", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok" });

    const config = JSON.parse(readFileSync(join(project, ".claude", "draft", "config.json"), "utf8"));
    expect(config.ingestToken).toBe("draft_sit_cred-2_secret");
    expect(config.projectId).toBe("project-1");
  });

  test("without an existing config, reports an operational error", async () => {
    const result = await runCli(["sessions", "rotate", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
  });

  test("rejects when the presented token doesn't verify", async () => {
    await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    backend.state.sessionTokensRotateResponse = () => Response.json({ ok: false, error: "invalid_ingest_token" }, { status: 401 });
    const result = await runCli(["sessions", "rotate", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
  });
});

describe("malformed settings.json", () => {
  test("enable refuses and leaves the file byte-for-byte unchanged", async () => {
    const settingsPath = join(project, ".claude", "settings.json");
    execSync(`mkdir -p ${join(project, ".claude")}`);
    writeFileSync(settingsPath, "{ not json");
    const before = readFileSync(settingsPath, "utf8");

    const result = await runCli(["sessions", "enable", "claude-code", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);

    const configPath = join(project, ".claude", "draft", "config.json");
    expect(existsSync(configPath)).toBe(false);
  });

  test("disable refuses and leaves the file byte-for-byte unchanged", async () => {
    await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    const settingsPath = join(project, ".claude", "settings.json");
    writeFileSync(settingsPath, "{ not json");
    const before = readFileSync(settingsPath, "utf8");

    const result = await runCli(["sessions", "disable", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });
});

describe("draft sessions status", () => {
  test("reports missing state before enable", async () => {
    const result = await runCli(["sessions", "status", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout)).toMatchObject({ configExists: false, hookInstalled: false });
  });

  test("reports installed state after enable", async () => {
    await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    const result = await runCli(["sessions", "status", "--dir", project, "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout)).toMatchObject({ configExists: true, hookInstalled: true });
  });
});

describe("draft sessions ingest (hook-only)", () => {
  test("degrades gracefully when there's no project config — exits 0, doesn't hang", async () => {
    const result = await runCli(["sessions", "ingest"], {
      home,
      apiUrl: backend.url,
      cwd: project,
      stdin: JSON.stringify({ session_id: "sess-1", transcript_path: join(project, "missing.jsonl"), cwd: project, reason: "clear" }),
    });
    expect(result.exitCode).toBe(0);
    expect(backend.state.sessionsIngestRequests).toHaveLength(0);
  });

  test("degrades gracefully on malformed stdin", async () => {
    const result = await runCli(["sessions", "ingest"], { home, apiUrl: backend.url, cwd: project, stdin: "not json" });
    expect(result.exitCode).toBe(0);
  });

  test("posts the transcript when config and transcript both exist", async () => {
    await runCli(["sessions", "enable", "claude-code", "--dir", project], { home, apiUrl: backend.url });
    const transcriptPath = join(project, "transcript.jsonl");
    writeFileSync(transcriptPath, `${JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hi" } })}\n`);

    const result = await runCli(["sessions", "ingest"], {
      home,
      apiUrl: backend.url,
      cwd: project,
      env: { CLAUDE_PROJECT_DIR: project },
      stdin: JSON.stringify({ session_id: "sess-1", transcript_path: transcriptPath, cwd: project, reason: "clear" }),
    });
    expect(result.exitCode).toBe(0);
    expect(backend.state.sessionsIngestRequests).toHaveLength(1);
    const req = backend.state.sessionsIngestRequests[0]!;
    expect(req.url).toContain("sessionId=sess-1");
    expect(req.url).toContain("gitEmail=dev%40example.com");
    expect(req.headers.authorization).toBe("Bearer draft_sit_cred-1_secret");
  });
});

describe("draft sessions list", () => {
  test("human mode prints one line per session", async () => {
    backend.state.sessionsListResponse = () => Response.json({
      sessions: [{
        id: "s1", provider: "claude-code-session", verified: true, display: "Ada", project: "flooently", cwd: "/repo",
        started_at: "2026-01-01T00:00:00Z", ended_at: null, status: "unknown", summary_status: "pending", has_summary: false,
      }],
    });
    const result = await runCli(["sessions", "list"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("s1");
    expect(result.stdout).toContain("Ada");
  });

  test("JSON mode returns the sessions array verbatim", async () => {
    backend.state.sessionsListResponse = () => Response.json({ sessions: [] });
    const result = await runCli(["sessions", "list", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, sessions: [] });
  });

  test("no sessions found reports plainly in human mode", async () => {
    backend.state.sessionsListResponse = () => Response.json({ sessions: [] });
    const result = await runCli(["sessions", "list"], { home, apiUrl: backend.url });
    expect(result.stdout).toBe("No sessions found.");
  });
});

describe("draft sessions read", () => {
  test("--summary default prints the summary text", async () => {
    backend.state.sessionReadResponse = () => Response.json({ summary: "# Summary text" });
    const result = await runCli(["sessions", "read", "s1"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("# Summary text");
  });

  test("--transcript prints each message", async () => {
    backend.state.sessionReadResponse = () => Response.json({
      messages: [{ seq: 0, role: "user", content: "hi", created_at: "x" }, { seq: 1, role: "assistant", content: "hello", created_at: "x" }],
    });
    const result = await runCli(["sessions", "read", "s1", "--transcript"], { home, apiUrl: backend.url });
    expect(result.stdout).toBe("[user] hi\n[assistant] hello");
  });

  test("--summary and --transcript are mutually exclusive", async () => {
    const result = await runCli(["sessions", "read", "s1", "--summary", "--transcript"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("missing session id is invalid usage", async () => {
    const result = await runCli(["sessions", "read"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("--grep/--context/--max-bytes with --summary is invalid usage", async () => {
    const result = await runCli(["sessions", "read", "s1", "--summary", "--grep", "x"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("--context without --grep is invalid usage", async () => {
    const result = await runCli(["sessions", "read", "s1", "--transcript", "--context", "2"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("--transcript --grep passes grep/context/maxBytes through to the backend and prints truncation notice", async () => {
    let requestedUrl: URL | null = null;
    backend.state.sessionReadResponse = (_workspaceId, _sessionId, url) => {
      requestedUrl = url;
      return Response.json({
        messages: [{ seq: 1, role: "user", content: "error found", created_at: "x" }],
        windows: [{ start_seq: 0, end_seq: 2 }],
        truncated_bytes: 42,
      });
    };
    const result = await runCli(
      ["sessions", "read", "s1", "--transcript", "--grep", "error", "--context", "1", "--max-bytes", "500"],
      { home, apiUrl: backend.url },
    );
    expect(result.exitCode).toBe(0);
    expect(requestedUrl?.searchParams.get("grep")).toBe("error");
    expect(requestedUrl?.searchParams.get("context")).toBe("1");
    expect(requestedUrl?.searchParams.get("maxBytes")).toBe("500");
    expect(result.stdout).toContain("[user] error found");
    expect(result.stdout).toContain("truncated 42 bytes");
  });
});

describe("draft sessions search", () => {
  test("human mode prints matches with snippets", async () => {
    backend.state.sessionsSearchResponse = () => Response.json({
      sessions: [{ session_id: "item-1", agent_session_id: "s1", provider: "claude-code-session", verified: true, display: "Ada", occurred_at: "2026-01-01T00:00:00Z", snippet: "...database migration..." }],
    });
    const result = await runCli(["sessions", "search", "migration"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("item-1");
    expect(result.stdout).toContain("database migration");
  });

  test("JSON mode returns the sessions array verbatim", async () => {
    backend.state.sessionsSearchResponse = () => Response.json({ sessions: [] });
    const result = await runCli(["sessions", "search", "migration", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, sessions: [] });
  });

  test("no matches reports plainly in human mode", async () => {
    backend.state.sessionsSearchResponse = () => Response.json({ sessions: [] });
    const result = await runCli(["sessions", "search", "migration"], { home, apiUrl: backend.url });
    expect(result.stdout).toBe("No matching sessions found.");
  });

  test("missing pattern is invalid usage", async () => {
    const result = await runCli(["sessions", "search"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("passes --provider/--user/--since through as query params", async () => {
    let requestedUrl: URL | null = null;
    backend.state.sessionsSearchResponse = (_workspaceId, url) => {
      requestedUrl = url;
      return Response.json({ sessions: [] });
    };
    await runCli(
      ["sessions", "search", "migration", "--provider", "claude-code-session", "--user", "ada@example.com", "--since", "2026-01-01"],
      { home, apiUrl: backend.url },
    );
    expect(requestedUrl?.searchParams.get("q")).toBe("migration");
    expect(requestedUrl?.searchParams.get("provider")).toBe("claude-code-session");
    expect(requestedUrl?.searchParams.get("user")).toBe("ada@example.com");
    expect(requestedUrl?.searchParams.get("since")).toBe("2026-01-01");
  });
});
