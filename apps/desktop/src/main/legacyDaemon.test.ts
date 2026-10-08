import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeLegacyDaemon } from "./legacyDaemon";

let root: string;
let paths: { plistPath: string; backgroundDir: string; uid: number };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "legacy-daemon-"));
  paths = { plistPath: join(root, "com.draft.daemon.plist"), backgroundDir: join(root, "background"), uid: 501 };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("removeLegacyDaemon", () => {
  test("boots out, kills, and deletes the plist and runtime dir", async () => {
    mkdirSync(paths.backgroundDir);
    writeFileSync(paths.plistPath, "<plist/>");
    writeFileSync(join(paths.backgroundDir, "draft-background.pid"), "4242");
    const runs: string[][] = [];
    const killed: number[] = [];
    await removeLegacyDaemon(paths, { run: async (cmd) => { runs.push(cmd); }, kill: (pid) => { killed.push(pid); } });
    expect(runs).toEqual([["launchctl", "bootout", "gui/501/com.draft.daemon"]]);
    expect(killed).toEqual([4242]);
    expect(existsSync(paths.plistPath)).toBe(false);
    expect(existsSync(paths.backgroundDir)).toBe(false);
  });

  test("does nothing when nothing is installed", async () => {
    const runs: string[][] = [];
    await removeLegacyDaemon(paths, { run: async (cmd) => { runs.push(cmd); }, kill: () => {} });
    expect(runs).toEqual([]);
  });
});
