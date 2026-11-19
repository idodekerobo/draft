import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { claudeRunner } from "draft-core/harnesses/claude/runner";
import { codexRunner } from "draft-core/harnesses/codex/runner";
import { findSessionFile, keepSessionFile, SESSION_FILE_MAX_BYTES, type PutObject } from "../../sandbox/runner/session-file";

const SESSION = "5f1c2a7e-9b3d-4e8a-8c2f-1a2b3c4d5e6f";
const UPLOAD = { fileUrl: "https://storage.example.test/root.jsonl.gz?token=file", metadataUrl: "https://storage.example.test/metadata.json?token=meta" };
const LINES = '{"type":"system","session_id":"5f1c2a7e-9b3d-4e8a-8c2f-1a2b3c4d5e6f"}\n{"type":"result"}\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-session-file-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Claude projects folder with the session's file in the folder named after its working directory. */
function claudeLayout(root: string, sessionId = SESSION, content = LINES): string {
  mkdirSync(join(root, "-run"), { recursive: true });
  const file = join(root, "-run", `${sessionId}.jsonl`);
  writeFileSync(file, content);
  return file;
}

/** Records every upload. `fail` names the url that should be refused. */
function recorder(fail?: string) {
  const puts: Array<{ url: string; body: Uint8Array; contentType: string }> = [];
  const put: PutObject = async (url, body, contentType) => {
    if (url === fail) throw new Error(`storage refused ${url}`);
    puts.push({ url, body, contentType });
  };
  return { puts, put };
}

const base = { runId: "RUN-1", harness: "claude" as const, side: claudeRunner.sessionFile, upload: UPLOAD, cliVersion: async () => "2.1.4" };

describe("findSessionFile", () => {
  it("finds a Claude session file in the folder named after its working directory", () => {
    const file = claudeLayout(dir);
    expect(findSessionFile(dir, claudeRunner.sessionFile, SESSION)).toBe(file);
  });

  it("finds a Codex rollout file in its date folders, and ignores other sessions", () => {
    const day = join(dir, "2026", "11", "19");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-11-19T10-00-00-${SESSION}.jsonl`);
    writeFileSync(rollout, "{}\n");
    writeFileSync(join(day, "rollout-2026-11-19T09-00-00-00000000-0000-4000-8000-000000000000.jsonl"), "{}\n");
    expect(findSessionFile(dir, codexRunner.sessionFile, SESSION)).toBe(rollout);
  });

  it("does not take a subagent's file for the session, and returns null when there is none", () => {
    mkdirSync(join(dir, "-run", SESSION, "subagents"), { recursive: true });
    writeFileSync(join(dir, "-run", SESSION, "subagents", "agent-abc.jsonl"), "{}\n");
    expect(findSessionFile(dir, claudeRunner.sessionFile, SESSION)).toBeNull();
    expect(findSessionFile(join(dir, "missing"), claudeRunner.sessionFile, SESSION)).toBeNull();
  });

  it("searches no deeper than a few folders", () => {
    const deep = join(dir, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, `${SESSION}.jsonl`), "{}\n");
    expect(findSessionFile(dir, claudeRunner.sessionFile, SESSION)).toBeNull();
  });
});

describe("keepSessionFile", () => {
  it("uploads the gzipped session file, then its metadata, and reports the file as kept", async () => {
    claudeLayout(dir);
    const { puts, put } = recorder();

    const kept = await keepSessionFile({ ...base, nativeSessionId: SESSION, root: dir, put });

    expect(kept).toBe(true);
    expect(puts.map((p) => [p.url, p.contentType])).toEqual([
      [UPLOAD.fileUrl, "application/gzip"],
      [UPLOAD.metadataUrl, "application/json"],
    ]);
    expect(gunzipSync(puts[0]!.body).toString("utf8")).toBe(LINES);
    expect(JSON.parse(new TextDecoder().decode(puts[1]!.body))).toEqual({
      harness: "claude",
      cli_version: "2.1.4",
      cwd: "/run",
      native_session_id: SESSION,
      run_id: "RUN-1",
      bytes: Buffer.byteLength(LINES),
    });
  });

  it("names the Codex working folder in the metadata of a Codex run", async () => {
    const day = join(dir, "2026", "11", "19");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-11-19T10-00-00-${SESSION}.jsonl`), "{}\n");
    const { puts, put } = recorder();

    await keepSessionFile({ ...base, harness: "codex", side: codexRunner.sessionFile, nativeSessionId: SESSION, root: dir, put });

    expect(JSON.parse(new TextDecoder().decode(puts[1]!.body))).toMatchObject({ harness: "codex", cwd: "/home/agent/work" });
  });

  it("skips a run with no native session id, and never builds a path from an id that is not plain", async () => {
    claudeLayout(dir);
    const { puts, put } = recorder();

    expect(await keepSessionFile({ ...base, nativeSessionId: null, root: dir, put })).toBe(false);
    expect(await keepSessionFile({ ...base, nativeSessionId: "../../etc/passwd", root: dir, put })).toBe(false);
    expect(puts).toEqual([]);
  });

  it("skips a session file that is not there", async () => {
    const { puts, put } = recorder();
    expect(await keepSessionFile({ ...base, nativeSessionId: SESSION, root: dir, put })).toBe(false);
    expect(puts).toEqual([]);
  });

  it("skips a session file over the cap, and uploads nothing", async () => {
    claudeLayout(dir);
    const { puts, put } = recorder();

    expect(await keepSessionFile({ ...base, nativeSessionId: SESSION, root: dir, put, maxBytes: 16 })).toBe(false);
    expect(puts).toEqual([]);
    expect(SESSION_FILE_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it("reports false when the file upload is refused, uploads no metadata, and does not throw", async () => {
    claudeLayout(dir);
    const { puts, put } = recorder(UPLOAD.fileUrl);
    const logs = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await keepSessionFile({ ...base, nativeSessionId: SESSION, root: dir, put })).toBe(false);
      expect(puts).toEqual([]);
      expect(logs.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringContaining("session_file_upload_failed")]);
    } finally {
      logs.mockRestore();
    }
  });

  it("reports the file as kept when only its metadata upload is refused", async () => {
    claudeLayout(dir);
    const { puts, put } = recorder(UPLOAD.metadataUrl);
    const logs = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await keepSessionFile({ ...base, nativeSessionId: SESSION, root: dir, put })).toBe(true);
      expect(puts.map((p) => p.url)).toEqual([UPLOAD.fileUrl]);
    } finally {
      logs.mockRestore();
    }
  });

  it("never throws, even when the folder cannot be read or the version lookup fails", async () => {
    const { put } = recorder();
    const logs = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(keepSessionFile({ ...base, nativeSessionId: SESSION, root: join(dir, "nope"), put })).resolves.toBe(false);
      claudeLayout(dir);
      await expect(
        keepSessionFile({ ...base, nativeSessionId: SESSION, root: dir, put, cliVersion: async () => { throw new Error("gosu missing"); } }),
      ).resolves.toBe(true);
    } finally {
      logs.mockRestore();
    }
  });
});

describe("the harness session file rules", () => {
  it("Claude names the file after its session, and reads the session id from its first lines", () => {
    expect(claudeRunner.sessionFile.isSessionFile(`${SESSION}.jsonl`, SESSION)).toBe(true);
    expect(claudeRunner.sessionFile.isSessionFile("other.jsonl", SESSION)).toBe(false);
    expect(claudeRunner.sessionFile.nativeSessionIdOfLine(LINES.split("\n")[0]!)).toBe(SESSION);
    expect(claudeRunner.sessionFile.nativeSessionIdOfLine('{"type":"assistant"}')).toBeNull();
    expect(claudeRunner.sessionFile.nativeSessionIdOfLine('{"session_id":"x"')).toBeNull();
  });

  it("Codex reads the thread id from its thread.started line", () => {
    expect(codexRunner.sessionFile.nativeSessionIdOfLine('{"type":"thread.started","thread_id":"019e-abc"}')).toBe("019e-abc");
    expect(codexRunner.sessionFile.nativeSessionIdOfLine('{"type":"turn.started"}')).toBeNull();
    expect(codexRunner.sessionFile.isSessionFile(`rollout-2026-11-19T10-00-00-${SESSION}.jsonl`, SESSION)).toBe(true);
  });
});
