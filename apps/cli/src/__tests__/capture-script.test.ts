import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { buildCaptureScript, HOOK_COMMAND, HOOK_TIMEOUT_SECONDS, mergeSessionEndHook } from "draft-core/sessions";

interface Captured {
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

let server: ReturnType<typeof Bun.serve>;
let ingestRequests: Captured[];
let reportRequests: Captured[];
let ingestResponse: () => Response | Promise<Response>;
let root: string;
let home: string;
let project: string;
let transcriptPath: string;

const TRANSCRIPT = '{"type":"user","message":{"role":"user","content":"hello"}}\n';

function writeConfig(overrides: Record<string, string> = {}, backendUrl = server.url.origin): void {
  const config = {
    backendUrl,
    workspaceId: "ws-1",
    ingestToken: "draft_sit_cred-1_secret",
    projectId: "project-1",
    projectKey: "key-1",
    allowedProviders: ["claude-code-session"],
    credentialScope: "ingest-only",
    ...overrides,
  };
  writeFileSync(join(project, ".claude", "draft", "config.json"), JSON.stringify(config, null, 2));
}

// The machine running the tests may have draft installed at the fixed path;
// point the script's second lookup somewhere empty so the curl branch runs.
// The default backend (used to report broken configs) must never be prod here.
function installScript(): string {
  const path = join(project, ".claude", "draft", "capture-session.sh");
  const script = buildCaptureScript()
    .replace("/usr/local/bin/draft", join(root, "no-such-draft"))
    .replace("https://api.draftai.us", server.url.origin);
  expect(script).not.toContain("api.draftai.us");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

async function runHook(hookInput: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const started = Date.now();
  const proc = Bun.spawn(["bash", join(project, ".claude", "draft", "capture-session.sh")], {
    stdin: new Blob([JSON.stringify(hookInput)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, DRAFT_BIN: "", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null", ...extraEnv },
  });
  const exitCode = await proc.exited;
  return { exitCode, elapsedMs: Date.now() - started };
}

function hookInput(overrides: Record<string, unknown> = {}) {
  return { session_id: "sess-1", transcript_path: transcriptPath, cwd: project, reason: "clear", ...overrides };
}

function readLog(): Record<string, string>[] {
  const logPath = join(home, ".draft", "log", "sessions-ingest.log");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

beforeEach(() => {
  ingestRequests = [];
  reportRequests = [];
  ingestResponse = () => Response.json({ ok: true, sessionId: "agent-1" });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const captured = { path: url.pathname, query: url.searchParams, headers: req.headers, body: await req.text() };
      if (url.pathname === "/sessions/ingest-errors") {
        reportRequests.push(captured);
        return Response.json({ ok: true }, { status: 202 });
      }
      ingestRequests.push(captured);
      return ingestResponse();
    },
  });
  root = mkdtempSync(join(tmpdir(), "draft-capture-"));
  home = join(root, "home");
  project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, ".claude", "draft"), { recursive: true });
  writeFileSync(join(root, "gitconfig"), "[user]\n\temail = dev@example.com\n\tname = Dév Exämple\n");
  execSync("git init -q", { cwd: project });
  transcriptPath = join(root, "transcript.jsonl");
  writeFileSync(transcriptPath, TRANSCRIPT);
  installScript();
  writeConfig();
});

afterEach(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("capture-session.sh without the draft CLI", () => {
  test("posts the transcript with the encoded identity and logs success", async () => {
    const { exitCode } = await runHook(hookInput());
    expect(exitCode).toBe(0);
    expect(ingestRequests).toHaveLength(1);
    const req = ingestRequests[0]!;
    expect(req.path).toBe("/sessions/ingest");
    expect(req.body).toBe(TRANSCRIPT);
    expect(req.headers.get("authorization")).toBe("Bearer draft_sit_cred-1_secret");
    expect(req.query.get("sessionId")).toBe("sess-1");
    expect(req.query.get("gitEmail")).toBe("dev@example.com");
    expect(req.query.get("displayName")).toBe("Dév Exämple");
    expect(req.query.get("cwd")).toBe(project);
    expect(req.query.get("status")).toBe("clear");
    expect(req.query.get("source")).toBe("claude-code-session");
    expect(reportRequests).toHaveLength(0);
    expect(readLog()[0]).toMatchObject({ status: "success", sessionId: "sess-1" });
  });

  test("unescapes JSON paths with backslashes and slashes", async () => {
    const weird = join(root, "we\\ird dir");
    mkdirSync(weird, { recursive: true });
    const file = join(weird, "t.jsonl");
    writeFileSync(file, TRANSCRIPT);
    await runHook(hookInput({ transcript_path: file }));
    expect(ingestRequests).toHaveLength(1);
    expect(ingestRequests[0]!.body).toBe(TRANSCRIPT);
  });

  test("reports a placeholder config without sending the transcript or the token", async () => {
    writeConfig({ ingestToken: "${DRAFT_INGEST_TOKEN}", backendUrl: "${DRAFT_BACKEND_URL}" }, "${DRAFT_BACKEND_URL}");
    const { exitCode } = await runHook(hookInput());
    expect(exitCode).toBe(0);
    expect(ingestRequests).toHaveLength(0);
    expect(readLog()[0]).toMatchObject({ status: "skipped", detail: "placeholder-config" });
    expect(reportRequests).toHaveLength(1);
    expect(JSON.parse(reportRequests[0]!.body).code).toBe("placeholder-config");
    expect(reportRequests[0]!.headers.get("authorization")).toBeNull();
  });

  test("reports an upload that the backend rejects, with the status in the code", async () => {
    ingestResponse = () => Response.json({ ok: false, error: "invalid_ingest_token" }, { status: 401 });
    const { exitCode } = await runHook(hookInput());
    expect(exitCode).toBe(0);
    expect(reportRequests).toHaveLength(1);
    const report = JSON.parse(reportRequests[0]!.body);
    expect(report).toMatchObject({ code: "http-401", scriptVersion: "2", hookReason: "clear", workspaceId: "ws-1" });
    expect(report.reason).toContain("invalid_ingest_token");
    expect(reportRequests[0]!.headers.get("authorization")).toBe("Bearer draft_sit_cred-1_secret");
    expect(readLog()[0]).toMatchObject({ status: "failure", detail: "status=401" });
  });

  test("reports a 500", async () => {
    ingestResponse = () => Response.json({ ok: false, error: "persist_failed" }, { status: 500 });
    await runHook(hookInput());
    expect(JSON.parse(reportRequests[0]!.body).code).toBe("http-500");
  });

  test("does not report session_tracking_disabled: that is policy, not a failure", async () => {
    ingestResponse = () => Response.json({ ok: false, error: "session_tracking_disabled" }, { status: 403 });
    await runHook(hookInput());
    expect(reportRequests).toHaveLength(0);
    expect(readLog()[0]).toMatchObject({ status: "skipped", detail: "session_tracking_disabled" });
  });

  test("reports a missing transcript", async () => {
    await runHook(hookInput({ transcript_path: join(root, "gone.jsonl") }));
    expect(ingestRequests).toHaveLength(0);
    expect(JSON.parse(reportRequests[0]!.body).code).toBe("missing-transcript");
  });

  test("reports a missing git email", async () => {
    writeFileSync(join(root, "gitconfig"), "");
    await runHook(hookInput());
    expect(ingestRequests).toHaveLength(0);
    expect(JSON.parse(reportRequests[0]!.body).code).toBe("missing-git-email");
  });

  test("reports an unreachable backend quickly and still exits 0", async () => {
    const unreachable = "http://127.0.0.1:9";
    writeConfig({}, unreachable);
    const { exitCode, elapsedMs } = await runHook(hookInput());
    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(15_000);
    expect(readLog()[0]).toMatchObject({ status: "failure" });
    expect(readLog()[0]!.detail).toContain("upload-failed");
  });

  test("a hung backend is cut off at the upload cap", async () => {
    ingestResponse = () => new Promise<Response>(() => {});
    const { exitCode, elapsedMs } = await runHook(hookInput());
    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(19_000);
    expect(elapsedMs).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000);
    expect(readLog()[0]!.detail).toContain("upload-timeout");
    expect(JSON.parse(reportRequests[0]!.body).code).toBe("upload-timeout");
  }, 40_000);
});

describe("capture-session.sh with the draft CLI installed", () => {
  test("hands the hook input to `draft sessions ingest` and makes no request of its own", async () => {
    const binDir = join(home, ".draft", "bin");
    mkdirSync(binDir, { recursive: true });
    const marker = join(root, "cli-called");
    writeFileSync(join(binDir, "draft"), `#!/usr/bin/env bash\necho "$@" > "${marker}"\ncat >> "${marker}"\n`);
    chmodSync(join(binDir, "draft"), 0o755);
    const { exitCode } = await runHook(hookInput());
    expect(exitCode).toBe(0);
    const recorded = readFileSync(marker, "utf8");
    expect(recorded).toContain("sessions ingest");
    expect(recorded).toContain('"session_id":"sess-1"');
    expect(ingestRequests).toHaveLength(0);
  });
});

describe("mergeSessionEndHook", () => {
  test("adds an async, time-capped hook", () => {
    const next = mergeSessionEndHook({});
    expect(next.hooks?.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS, async: true }] },
    ]);
  });

  test("is a no-op, returning the same object, when the hook is current", () => {
    const current = mergeSessionEndHook({});
    expect(mergeSessionEndHook(current)).toBe(current);
  });

  test("upgrades an older entry in place and keeps unrelated hooks", () => {
    const old = {
      hooks: {
        SessionEnd: [
          { hooks: [{ type: "command", command: "other.sh" }] },
          { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] },
        ],
      },
    };
    const next = mergeSessionEndHook(old);
    expect(next).not.toBe(old);
    expect(next.hooks?.SessionEnd?.[0]).toEqual({ hooks: [{ type: "command", command: "other.sh" }] });
    expect(next.hooks?.SessionEnd?.[1]?.hooks[0]).toEqual({ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS, async: true });
    expect(mergeSessionEndHook(next)).toBe(next);
  });
});
