import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "host");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function importedModules(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
}

// Core is shared by every app, so the host must not depend on the desktop shell.
const FORBIDDEN = [/^electrobun(\/|$)/, /^draft-shared-ui(\/|$)/, /(^|\/)apps\//];

describe("the host folder", () => {
  const files = sourceFiles(ROOT);

  it("finds the files it checks", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    it(`${file.slice(ROOT.length + 1)} imports no app shell module`, () => {
      const bad = importedModules(readFileSync(file, "utf8")).filter((spec) => FORBIDDEN.some((rule) => rule.test(spec)));
      expect(bad).toEqual([]);
    });
  }
});
