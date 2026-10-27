import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { makeHome, runCli } from "./helpers/cli-runner.ts";
import { performUninstall, type UninstallPaths } from "../commands/uninstall.ts";

let home: string;
let paths: UninstallPaths;

beforeEach(() => {
  home = makeHome();
  mkdirSync(join(home, ".draft", "bin"), { recursive: true });
  paths = {
    binPath: join(home, ".draft", "bin", "draft"),
    systemLink: join(home, "usr-local-bin-draft"),
    profiles: [join(home, ".zprofile")],
  };
  writeFileSync(paths.binPath, "binary");
  writeFileSync(join(home, ".draft", "bin", "tmux"), "tmux");
  writeFileSync(join(home, ".draft", "config.json"), "{}");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("performUninstall", () => {
  test("removes the binary and its link but keeps other ~/.draft files", () => {
    symlinkSync(paths.binPath, paths.systemLink);
    const result = performUninstall(paths);
    expect(result.removed).toEqual([paths.systemLink, paths.binPath]);
    expect(existsSync(paths.binPath)).toBe(false);
    expect(existsSync(join(home, ".draft", "bin", "tmux"))).toBe(true);
    expect(existsSync(join(home, ".draft", "config.json"))).toBe(true);
  });

  test("leaves a link that points somewhere else", () => {
    const other = join(home, "other-draft");
    writeFileSync(other, "x");
    symlinkSync(other, paths.systemLink);
    performUninstall(paths);
    expect(existsSync(paths.systemLink)).toBe(true);
  });

  test("strips only the Draft PATH line from the profile", () => {
    writeFileSync(
      paths.profiles[0]!,
      'export FOO=1\nexport PATH="$HOME/.draft/bin:$PATH"  # added by Draft\nexport BAR=2\n',
    );
    const result = performUninstall(paths);
    expect(result.removed).toContain(paths.profiles[0]);
    expect(readFileSync(paths.profiles[0]!, "utf8")).toBe("export FOO=1\nexport BAR=2\n");
  });

  test("is a no-op when nothing is installed", () => {
    rmSync(paths.binPath);
    expect(performUninstall(paths)).toEqual({ removed: [], failed: [] });
  });
});

describe("draft uninstall", () => {
  test("--json without --yes is a usage error", async () => {
    const res = await runCli(["uninstall", "--json"], { home, apiUrl: "http://127.0.0.1:1" });
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("confirmation_required");
    expect(existsSync(paths.binPath)).toBe(true);
  });

  test("rejects unknown arguments", async () => {
    const res = await runCli(["uninstall", "--purge"], { home, apiUrl: "http://127.0.0.1:1" });
    expect(res.exitCode).toBe(2);
  });
});
