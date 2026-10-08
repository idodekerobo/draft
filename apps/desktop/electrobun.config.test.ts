import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function config(mode: string) {
  const result = Bun.spawnSync([process.execPath, "--eval", 'const {default: config} = await import("./electrobun.config.ts"); console.log(JSON.stringify(config));', mode], { cwd: import.meta.dir });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

describe("worktree desktop configuration", () => {
  test("development copies and watches only tracked assets", () => {
    const dev = config("dev");
    for (const source of Object.keys(dev.build.copy)) expect(existsSync(resolve(import.meta.dir, source))).toBe(true);
    expect(existsSync(resolve(import.meta.dir, dev.build.mac.icons))).toBe(true);
    expect(dev.build.bun.define["process.env.DRAFT_DESKTOP_DEV"]).toBe('"1"');
    expect(dev.scripts.postBuild).toBe("");
  });
  test("release builds retain generated assets and packaging hooks", () => {
    const release = config("build");
    expect(release.build.copy["assets/background/"]).toBeUndefined();
    expect(release.build.mac.icons).toBe("assets/icon.iconset");
    expect(release.build.bun.define["process.env.DRAFT_DESKTOP_DEV"]).toBe('"0"');
    expect(release.scripts.postBuild).toBe("scripts/postbuild.ts");
  });
});
