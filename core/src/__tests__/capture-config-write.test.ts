import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { atomicPatch } from "../sync/atomic-write";
import { writeCaptureConfigAtomic } from "../sync/claude-settings";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-capture-config-"));
  file = join(dir, "config.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const backups = () => readdirSync(dir).filter((name) => name.includes(".draft-bak-"));

describe("writeCaptureConfigAtomic", () => {
  test("replaces the config without leaving backup files", async () => {
    writeFileSync(file, '{"ingestToken":"old"}\n');
    await writeCaptureConfigAtomic(file, { ingestToken: "new" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ingestToken: "new" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(backups()).toEqual([]);
  });

  test("leaves the file byte-for-byte alone when the JSON is unchanged", async () => {
    const original = '{"allowedProviders": ["claude-code-session"], "ingestToken": "t"}';
    writeFileSync(file, original);
    await writeCaptureConfigAtomic(file, { ingestToken: "t", allowedProviders: ["claude-code-session"] });
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(backups()).toEqual([]);
  });
});

describe("atomicPatch backups", () => {
  test("still writes backups by default", async () => {
    writeFileSync(file, "before");
    await atomicPatch(file, () => "after");
    expect(backups().length).toBeGreaterThan(0);
  });

  test("skips backups with backup: false", async () => {
    writeFileSync(file, "before");
    await atomicPatch(file, () => "after", { backup: false });
    expect(readFileSync(file, "utf8")).toBe("after");
    expect(backups()).toEqual([]);
  });
});
