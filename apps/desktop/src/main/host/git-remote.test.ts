import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitRemote } from "./git-remote";

const dir = mkdtempSync(join(tmpdir(), "git-remote-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);

describe("gitRemote", () => {
  it("is null outside a repo and in a repo without origin", async () => {
    expect(await gitRemote(dir)).toBeNull();
    git("init", "-q");
    expect(await gitRemote(dir)).toBeNull();
  });

  it("returns the origin URL", async () => {
    git("remote", "add", "origin", "https://github.com/acme/marigold.git");
    expect(await gitRemote(dir)).toBe("https://github.com/acme/marigold.git");
  });
});
