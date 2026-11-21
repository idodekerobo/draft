import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installHostServices } from "../../host/services";

const root = mkdtempSync(join(tmpdir(), "resume-failures-"));
const { SessionFailureReporter } = await import("../../host/failures");
const reporter = new SessionFailureReporter(() => join(root, "failures"));
const reportSessionFailure = reporter.report.bind(reporter);
const flushSessionFailures = reporter.flush.bind(reporter);
afterAll(() => { reporter.dispose(); rmSync(root, { recursive: true, force: true }); });

test("persists offline reports, retries with a stable ID, and never stores raw error content", async () => {
  let online = false;
  const received: any[] = [];
  const paths: string[] = [];
  installHostServices({ workspaceId: () => "workspace", hostId: () => "host",
    fetchServer: async (_path, init) => { if (!online) throw Error("offline"); paths.push(_path); received.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); },
    fetchServerJSON: async () => { throw Error("unused"); },
    realtime: { connected: () => false, watch: () => () => {}, send() {} },
    capture: async () => { throw Error("unused"); }, openInTerminal: async () => ({ ok: true }),
  });
  const error = Object.assign(new Error("Bearer secret-token: raw conversation must never be stored"), { code: -1, exitCode: 137 });
  error.name = "RpcError";
  const failure = reportSessionFailure({ sessionId: "session", workspaceId: "workspace", hostId: "host", harness: "codex", code: "resume_failed", requestId: crypto.randomUUID(), phase: "resume", terminal: true, error });
  await flushSessionFailures();
  const files = readdirSync(join(root, "failures"));
  expect(files).toEqual([`${failure.id}.json`]);
  const path = join(root, "failures", files[0]!);
  const saved = readFileSync(path, "utf8");
  expect(saved).not.toContain("secret-token");
  expect(saved).not.toContain("raw conversation");
  expect(JSON.parse(saved).diagnostics).toEqual({ errorName: "RpcError", reason: "rpc_rejected", transportCode: -1, exitCode: 137 });
  online = true;
  await flushSessionFailures();
  expect(received[0].id).toBe(failure.id);
  expect(paths[0]).toBe("workspaces/workspace/errors");
  expect(received[0].sessionFailure.terminal).toBe(true);
  expect(received[0].operation).toBe("session");
  expect(readdirSync(join(root, "failures"))).toEqual([]);
  writeFileSync(path, saved);
  await flushSessionFailures();
  expect(received[1].id).toBe(failure.id);
  expect(readdirSync(join(root, "failures"))).toEqual([]);
});
