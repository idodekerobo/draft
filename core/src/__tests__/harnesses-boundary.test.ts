import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "harnesses");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function importedModules(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
}

// A harness folder holds pure rules and the harness's own runner code. The database and the keys stay in the backend.
const FORBIDDEN = [/@supabase\//, /^zod$/, /backend/, /(^|\/)crypto$/, /^node:crypto$/, /(^|\/)db(\/|$)/];

describe("the harness folders", () => {
  const files = sourceFiles(ROOT);

  it("finds the files it checks", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    it(`${file.slice(ROOT.length + 1)} imports no database client, key code or backend module`, () => {
      const bad = importedModules(readFileSync(file, "utf8")).filter((spec) => FORBIDDEN.some((rule) => rule.test(spec)));
      expect(bad).toEqual([]);
    });
  }
});
