import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROUTINES = normalize(join(import.meta.dir, "../../routines"));
const WORKFLOW = join(ROUTINES, "workflow");
const GUIDANCE = join(ROUTINES, "built-in/synthesis/guidance");
const COMPOSITION_ROOT = join(ROUTINES, "register-workflows.ts");

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}(?:\/[^"']*)?)\1/g;

const sources = (dir: string, deep: boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return deep ? sources(path, deep) : [];
    return entry.name.endsWith(".ts") ? [path] : [];
  });

/** Every relative import of a file, resolved to an absolute path without its extension. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(SPECIFIER)].map((match) => normalize(join(dirname(file), match[2]!)));
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

describe("the routines folder keeps its imports running one way", () => {
  it("has files to check", () => {
    expect(sources(WORKFLOW, true).length).toBeGreaterThan(8);
    expect(sources(ROUTINES, false).length).toBeGreaterThan(20);
  });

  it("keeps the step engine free of the code that uses it", () => {
    const violations = sources(WORKFLOW, true).flatMap((file) =>
      importsOf(file)
        .filter((target) => inside(target, ROUTINES) && !inside(target, WORKFLOW))
        .map((target) => `${relative(ROUTINES, file)} imports ${relative(ROUTINES, target)}`),
    );
    expect(violations).toEqual([]);
  });

  it("lets the routine files reach into built-in routines only for the guidance defaults", () => {
    const violations = sources(ROUTINES, false)
      .filter((file) => file !== COMPOSITION_ROOT)
      .flatMap((file) =>
        importsOf(file)
          .filter((target) => inside(target, join(ROUTINES, "built-in")) && target !== GUIDANCE)
          .map((target) => `${relative(ROUTINES, file)} imports ${relative(ROUTINES, target)}`),
      );
    expect(violations).toEqual([]);
  });
});
