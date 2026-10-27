import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { linkOnPath, type PathLinkTargets } from "./pathLink";

let root: string;
let t: PathLinkTargets;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pathlink-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".draft", "bin"), { recursive: true });
  mkdirSync(join(root, "usrlocal", "bin"), { recursive: true });
  writeFileSync(join(home, ".draft", "bin", "draft"), "");
  t = {
    binPath: join(home, ".draft", "bin", "draft"),
    link: join(root, "usrlocal", "bin", "draft"),
    home,
    shell: "/bin/zsh",
  };
});

afterEach(() => {
  chmodSync(join(root, "usrlocal", "bin"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("linkOnPath", () => {
  test("creates the symlink when missing", () => {
    expect(linkOnPath(t).ok).toBe(true);
    expect(readlinkSync(t.link)).toBe(t.binPath);
  });

  test("leaves a current symlink untouched", () => {
    symlinkSync(t.binPath, t.link);
    const before = lstatSync(t.link).ino;
    linkOnPath(t);
    expect(lstatSync(t.link).ino).toBe(before);
  });

  test("replaces a stale symlink that points into ~/.draft", () => {
    symlinkSync(join(t.home, ".draft", "old", "draft"), t.link);
    linkOnPath(t);
    expect(readlinkSync(t.link)).toBe(t.binPath);
  });

  test("leaves a symlink pointing elsewhere alone", () => {
    const other = join(root, "brew-draft");
    symlinkSync(other, t.link);
    expect(linkOnPath(t).ok).toBe(true);
    expect(readlinkSync(t.link)).toBe(other);
  });

  test("leaves a regular file alone", () => {
    writeFileSync(t.link, "user binary");
    expect(linkOnPath(t).ok).toBe(true);
    expect(readFileSync(t.link, "utf8")).toBe("user binary");
  });

  test("falls back to the profile once, and only once", () => {
    chmodSync(join(root, "usrlocal", "bin"), 0o555);
    const profile = join(t.home, ".zprofile");

    expect(linkOnPath(t).ok).toBe(true);
    expect(existsSync(t.link)).toBe(false);
    expect(readFileSync(profile, "utf8")).toContain('export PATH="$HOME/.draft/bin:$PATH"');

    const once = readFileSync(profile, "utf8");
    linkOnPath(t);
    expect(readFileSync(profile, "utf8")).toBe(once);
  });
});
