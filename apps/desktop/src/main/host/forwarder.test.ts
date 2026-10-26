import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FileCursor } from "./cursor-store";
import { TranscriptForwarder, findTranscript, readCompleteLines, type ForwardedLine } from "./forwarder";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forwarder-"));
  dirs.push(dir);
  return dir;
}

const line = (n: number, extra = "") => JSON.stringify({ type: "user", uuid: `u-${n}`, n, pad: extra });

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
    const root = projectDir();
    mkdirSync(join(root, "-some-long-hashed-folder"));
    writeFileSync(join(root, "-some-long-hashed-folder", "abc.jsonl"), "");
    expect(findTranscript("abc", root)).toBe(join(root, "-some-long-hashed-folder", "abc.jsonl"));
    expect(findTranscript("missing", root)).toBeNull();
  });
});

/** A fake host around the forwarder: records posts and the last saved cursors. */
function harness(root: string, options: { cursors?: Record<string, FileCursor>; fail?: () => boolean; fatal?: (e: unknown) => boolean } = {}) {
  const rootPath = join(root, "n1.jsonl");
  const posted: ForwardedLine[] = [];
  const posts: ForwardedLine[][] = [];
  const state = { cursors: options.cursors ?? ({} as Record<string, FileCursor>), fatal: 0 };
  const forwarder = new TranscriptForwarder({
    nativeSessionId: "n1",
    cursors: state.cursors,
    onCursors: (c) => void (state.cursors = c),
    post: async (lines) => {
      if (options.fail?.()) throw new Error("network");
      posts.push(lines);
      posted.push(...lines);
    },
    isFatal: options.fatal ?? (() => false),
    onFatal: () => void state.fatal++,
    locate: () => (Bun.file(rootPath).size >= 0 ? rootPath : null),
  });
  return { forwarder, posted, posts, state, rootPath };
}

const raws = (lines: ForwardedLine[], file = "root.jsonl") => lines.filter((l) => l.file === file).map((l) => JSON.parse(l.raw!).n);

describe("TranscriptForwarder", () => {
  it("posts each line once as the file grows and holds back a partial line", async () => {
    const root = projectDir();
    const h = harness(root);
    writeFileSync(h.rootPath, `${line(1)}\n${line(2)}\n{"n"`);
    await h.forwarder.tick();
    await h.forwarder.tick();
    expect(raws(h.posted)).toEqual([1, 2]);

    appendFileSync(h.rootPath, `:3,"uuid":"u-3"}\n`);
    await h.forwarder.tick();
    expect(raws(h.posted)).toEqual([1, 2, 3]);
  });

  it("retries from the same place after a failed post, with no gap and no loss", async () => {
    const root = projectDir();
    let failing = true;
    const h = harness(root, { fail: () => failing });
    writeFileSync(h.rootPath, `${line(1)}\n${line(2)}\n`);
    await h.forwarder.tick();
    expect(h.posted).toEqual([]);
    failing = false;
    await h.forwarder.tick();
    expect(raws(h.posted)).toEqual([1, 2]);
  });

  it("stops and reports when the server says the session can no longer accept lines", async () => {
    const root = projectDir();
    const h = harness(root, { fail: () => true, fatal: () => true });
    writeFileSync(h.rootPath, `${line(1)}\n`);
    await h.forwarder.tick();
    expect(h.state.fatal).toBe(1);
  });

  it("resumes after a restart with no gaps and no duplicates", async () => {
    const root = projectDir();
    const first = harness(root);
    writeFileSync(first.rootPath, Array.from({ length: 300 }, (_, i) => line(i)).join("\n") + "\n");
    await first.forwarder.tick();
    expect(first.posted).toHaveLength(300);

    appendFileSync(first.rootPath, Array.from({ length: 200 }, (_, i) => line(300 + i)).join("\n") + "\n");
    const second = harness(root, { cursors: first.state.cursors });
    await second.forwarder.tick();

    expect(raws(second.posted)).toEqual(Array.from({ length: 200 }, (_, i) => 300 + i));
    expect(second.posted.some((l) => raws([l])[0]! < 300)).toBe(false);
  });

  it("replays a recorded session through repeated restarts without gaps or duplicates", async () => {
    const root = projectDir();
    const total = 400;
    const all = Array.from({ length: total }, (_, i) => line(i)).join("\n") + "\n";
    const rootPath = join(root, "n1.jsonl");
    const seen: number[] = [];
    let cursors: Record<string, FileCursor> = {};

    // Each step is a new app run that sees a longer file, often cut in the middle of a line.
    const cuts = [...Array.from({ length: Math.floor(all.length / 997) }, (_, i) => (i + 1) * 997), all.length];
    for (const end of cuts) {
      writeFileSync(rootPath, all.slice(0, end));
      const run = harness(root, { cursors });
      await run.forwarder.tick();
      seen.push(...raws(run.posted));
      cursors = run.state.cursors;
    }

    expect(cuts.length).toBeGreaterThan(5);
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
  });

  it("starts over when the file is replaced by a different one", async () => {
    const root = projectDir();
    const h = harness(root);
    writeFileSync(h.rootPath, `${line(1)}\n${line(2)}\n${line(3)}\n`);
    await h.forwarder.tick();

    writeFileSync(h.rootPath, `${line(10)}\n${line(11)}\n${line(12)}\n${line(13)}\n`);
    await h.forwarder.tick();
    expect(raws(h.posted)).toEqual([1, 2, 3, 10, 11, 12, 13]);
  });

  it("starts over when the file shrinks", async () => {
    const root = projectDir();
    const h = harness(root);
    writeFileSync(h.rootPath, `${line(1)}\n${line(2)}\n`);
    await h.forwarder.tick();
    writeFileSync(h.rootPath, `${line(9)}\n`);
    await h.forwarder.tick();
    expect(raws(h.posted)).toEqual([1, 2, 9]);
  });

  it("does not repost a line it already sent when the file is rescanned", async () => {
    const root = projectDir();
    const h = harness(root);
    writeFileSync(h.rootPath, `${line(1)}\n${line(2)}\n`);
    await h.forwarder.tick();
    writeFileSync(h.rootPath, `${line(0)}\n${line(1)}\n${line(2)}\n${line(3)}\n`);
    await h.forwarder.tick();
    expect(raws(h.posted)).toEqual([1, 2, 0, 3]);
  });

  it("tracks sub-agent files with their own cursor and label", async () => {
    const root = projectDir();
    const h = harness(root);
    writeFileSync(h.rootPath, `${line(1)}\n`);
    await h.forwarder.tick();

    mkdirSync(join(root, "n1", "subagents"), { recursive: true });
    writeFileSync(join(root, "n1", "subagents", "agent-a1.jsonl"), `${line(20)}\n${line(21)}\n`);
    await h.forwarder.tick();
    appendFileSync(join(root, "n1", "subagents", "agent-a1.jsonl"), `${line(22)}\n`);
    await h.forwarder.tick();

    expect(raws(h.posted, "root.jsonl")).toEqual([1]);
    expect(raws(h.posted, "subagents/agent-a1.jsonl")).toEqual([20, 21, 22]);
    expect(Object.keys(h.state.cursors).sort()).toEqual(["root.jsonl", "subagents/agent-a1.jsonl"]);
    expect(h.forwarder.files().map((f) => f.label)).toEqual(["root.jsonl", "subagents/agent-a1.jsonl"]);
  });

  it("posts a line longer than one read intact", async () => {
    const root = projectDir();
    const h = harness(root);
    const big = line(1, "x".repeat(3 * 1024 * 1024));
    writeFileSync(h.rootPath, `${big}\n${line(2)}\n`);
    await h.forwarder.tick();
    expect(h.posted.map((l) => l.raw)).toEqual([big, line(2)]);
  });

  it("sends only the size of an item too large to post, and keeps going", async () => {
    const root = projectDir();
    const h = harness(root);
    const huge = line(1, "y".repeat(6 * 1024 * 1024));
    writeFileSync(h.rootPath, `${line(0)}\n${huge}\n${line(2)}\n`);
    await h.forwarder.tick();

    const second = h.posted[1]!;
    expect(second.raw).toBeUndefined();
    expect(second.oversizeBytes).toBe(Buffer.byteLength(huge));
    expect(second.offset).toBe(Buffer.byteLength(line(0)) + 1);
    expect(raws(h.posted.filter((l) => l.raw !== undefined))).toEqual([0, 2]);
  });

  it("splits a large backlog into posts that each fit the request limit", async () => {
    const root = projectDir();
    const h = harness(root);
    const body = "z".repeat(500_000);
    writeFileSync(h.rootPath, Array.from({ length: 12 }, (_, i) => line(i, body)).join("\n") + "\n");
    await h.forwarder.tick();

    expect(h.posts.length).toBeGreaterThan(1);
    for (const post of h.posts) expect(Buffer.byteLength(JSON.stringify(post))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(raws(h.posted)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("waits until the transcript file exists", async () => {
    const root = projectDir();
    let located: string | null = null;
    const posted: string[] = [];
    const rootPath = join(root, "n1.jsonl");
    const forwarder = new TranscriptForwarder({
      nativeSessionId: "n1",
      cursors: {},
      onCursors: () => {},
      post: async (lines) => void posted.push(...lines.map((l) => l.raw!)),
      isFatal: () => false,
      onFatal: () => {},
      locate: () => located,
    });
    await forwarder.tick();
    located = rootPath;
    writeFileSync(rootPath, `${line(1)}\n`);
    await forwarder.tick();
    expect(posted).toEqual([line(1)]);
  });
});
