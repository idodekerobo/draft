import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CaptureResult } from "../../exec";
import { installHostServices } from "../../host/services";
import { fakeHostServices } from "./fake-host-services";
import { gitRemote } from "../../host/git-remote";

// headless.test.ts mocks the exec module for the whole run, so this test spawns the process itself.
async function capture(argv: string[]): Promise<CaptureResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
}

const dir = mkdtempSync(join(tmpdir(), "git-remote-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(() => {
  installHostServices(fakeHostServices({ capture }));
});
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
