import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TranscriptForwarder, findTranscript, readCompleteLines, type ForwardedLine } from "./forwarder";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "forwarder-"));
  dirs.push(dir);
  return join(dir, "session.jsonl");
}

describe("readCompleteLines", () => {
  it("returns complete lines with their byte offsets and leaves a partial line", () => {
    const { lines, consumed } = readCompleteLines(Buffer.from('{"a":1}\n{"b":2}\n{"c":'), 100);
    expect(lines).toEqual([
      { file: "root.jsonl", offset: 100, raw: '{"a":1}' },
      { file: "root.jsonl", offset: 108, raw: '{"b":2}' },
    ]);
    expect(consumed).toBe(16);
  });

  it("counts offsets in bytes, not characters", () => {
    const { lines } = readCompleteLines(Buffer.from('{"t":"é"}\n{"t":"b"}\n'), 0);
    expect(lines[1]!.offset).toBe(Buffer.byteLength('{"t":"é"}\n'));
  });

  it("skips blank lines", () => {
    expect(readCompleteLines(Buffer.from("\n\n{}\n"), 0).lines.map((l) => l.raw)).toEqual(["{}"]);
  });
});

describe("findTranscript", () => {
  it("finds the file by session id under any project folder", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-"));
    dirs.push(root);
    mkdirSync(join(root, "-some-long-hashed-folder"));
    writeFileSync(join(root, "-some-long-hashed-folder", "abc.jsonl"), "");
    expect(findTranscript("abc", root)).toBe(join(root, "-some-long-hashed-folder", "abc.jsonl"));
    expect(findTranscript("missing", root)).toBeNull();
  });
});

function forwarder(path: string | null, post: (lines: ForwardedLine[]) => Promise<void>, onFatal = () => {}) {
  return new TranscriptForwarder({
    nativeSessionId: "n1",
    post,
    isFatal: (error) => error instanceof Error && error.message === "session_ended",
    onFatal,
    locate: () => path,
  });
}

describe("TranscriptForwarder", () => {
  it("posts each line once as the file grows and holds back a partial line", async () => {
    const path = tempFile();
    const posted: string[] = [];
    const f = forwarder(path, async (lines) => void posted.push(...lines.map((l) => l.raw)));

    writeFileSync(path, '{"n":1}\n{"n":2}\n{"n"');
    await f.tick();
    expect(posted).toEqual(['{"n":1}', '{"n":2}']);

    await f.tick();
    expect(posted).toHaveLength(2);

    appendFileSync(path, ':3}\n');
    await f.tick();
    expect(posted).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it("retries from the same offset after a failed post, with no gap and no loss", async () => {
    const path = tempFile();
    writeFileSync(path, '{"n":1}\n{"n":2}\n');
    const posted: string[] = [];
    let fail = true;
    const f = forwarder(path, async (lines) => {
      if (fail) throw new Error("network");
      posted.push(...lines.map((l) => l.raw));
    });

    await f.tick();
    expect(posted).toEqual([]);
    fail = false;
    await f.tick();
    expect(posted).toEqual(['{"n":1}', '{"n":2}']);
  });

  it("waits until the transcript file exists", async () => {
    const path = tempFile();
    let located: string | null = null;
    const posted: string[] = [];
    const f = new TranscriptForwarder({
      nativeSessionId: "n1",
      post: async (lines) => void posted.push(...lines.map((l) => l.raw)),
      isFatal: () => false,
      onFatal: () => {},
      locate: () => located,
    });
    await f.tick();
    located = path;
    writeFileSync(path, '{"n":1}\n');
    await f.tick();
    expect(posted).toEqual(['{"n":1}']);
  });

  it("stops and reports when the server says the session can no longer accept lines", async () => {
    const path = tempFile();
    writeFileSync(path, '{"n":1}\n');
    let fatal = 0;
    const f = forwarder(path, async () => { throw new Error("session_ended"); }, () => void fatal++);
    await f.tick();
    expect(fatal).toBe(1);
  });

  it("restarts from the top when the file shrinks", async () => {
    const path = tempFile();
    const posted: string[] = [];
    const f = forwarder(path, async (lines) => void posted.push(...lines.map((l) => l.raw)));
    writeFileSync(path, '{"n":1}\n{"n":2}\n');
    await f.tick();
    writeFileSync(path, '{"n":9}\n');
    await f.tick();
    expect(posted.at(-1)).toBe('{"n":9}');
  });
});
