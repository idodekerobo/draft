import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeltaTail } from "./delta-tail";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(initial = "") {
  const dir = mkdtempSync(join(tmpdir(), "delta-tail-"));
  dirs.push(dir);
  const path = join(dir, "s1.deltas");
  writeFileSync(path, initial);
  const seen: Record<string, unknown>[] = [];
  const tail = new DeltaTail({ path, onPayload: (payload) => void seen.push(payload), pollMs: 60_000 });
  return { path, tail, seen };
}

describe("DeltaTail", () => {
  it("starts at the end of the file, so old lines are never replayed", () => {
    const t = setup('{"old":1}\n');
    t.tail.start();
    appendFileSync(t.path, '{"new":2}\n');
    t.tail.poll();
    t.tail.stop();
    expect(t.seen).toEqual([{ new: 2 }]);
  });

  it("holds a half-written line until it is complete", () => {
    const t = setup();
    t.tail.start();
    appendFileSync(t.path, '{"c":');
    t.tail.poll();
    expect(t.seen).toEqual([]);
    appendFileSync(t.path, "3}\n");
    t.tail.poll();
    t.tail.stop();
    expect(t.seen).toEqual([{ c: 3 }]);
  });

  it("skips a malformed line and a line that is not an object", () => {
    const t = setup();
    t.tail.start();
    appendFileSync(t.path, 'not json\n[1]\n5\n{"ok":true}\n');
    t.tail.poll();
    t.tail.stop();
    expect(t.seen).toEqual([{ ok: true }]);
  });

  it("reads from the start again when the file was truncated", () => {
    const t = setup();
    t.tail.start();
    appendFileSync(t.path, '{"first":1}\n{"second":2}\n');
    t.tail.poll();
    writeFileSync(t.path, '{"again":3}\n');
    t.tail.poll();
    t.tail.stop();
    expect(t.seen).toEqual([{ first: 1 }, { second: 2 }, { again: 3 }]);
  });

  it("empties a file that grew past the size limit once it has read it all", () => {
    const t = setup();
    t.tail.start();
    appendFileSync(t.path, `{"big":"${"x".repeat(9 * 1024 * 1024)}"}\n`);
    t.tail.poll();
    expect(statSync(t.path).size).toBe(0);
    appendFileSync(t.path, '{"after":1}\n');
    t.tail.poll();
    t.tail.stop();
    expect(t.seen.map((payload) => Object.keys(payload)[0])).toEqual(["big", "after"]);
  });

  it("keeps going when the handler throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-tail-"));
    dirs.push(dir);
    const path = join(dir, "s2.deltas");
    writeFileSync(path, "");
    const seen: unknown[] = [];
    const tail = new DeltaTail({
      path,
      onPayload: (payload) => {
        seen.push(payload);
        if (seen.length === 1) throw new Error("boom");
      },
      pollMs: 60_000,
    });
    tail.start();
    appendFileSync(path, '{"a":1}\n{"b":2}\n');
    tail.poll();
    tail.stop();
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("does nothing while the file does not exist", () => {
    const t = setup();
    rmSync(t.path);
    t.tail.start();
    t.tail.poll();
    t.tail.stop();
    expect(t.seen).toEqual([]);
  });

  it("keeps the file on stop, and removes it when asked", () => {
    const t = setup();
    t.tail.start();
    t.tail.stop();
    expect(existsSync(t.path)).toBe(true);
    t.tail.stop(true);
    expect(existsSync(t.path)).toBe(false);
  });
});
