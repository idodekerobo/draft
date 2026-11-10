import { beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "sandbox", "runner.ts");

// The runner runs in the sandbox, a separate computer. Only runner-side files may be in its bundle.
const ALLOWED_MODULES = [
  /^src\/sandbox\/runner(\/.+)?\.ts$/,
  /^\.\.\/core\/src\/harnesses\/[^/]+\/runner\.ts$/,
  /^\.\.\/core\/src\/harnesses\/failure\.ts$/,
  /^\.\.\/core\/src\/run-manifest\.ts$/,
  /^\.\.\/core\/src\/run-spec\.ts$/,
];
const FORBIDDEN_TEXT = ["@supabase", "serviceClient", "zod", "SUPABASE_SERVICE_ROLE_KEY"];

let bundle = "";

beforeAll(async () => {
  const result = await Bun.build({ entrypoints: [ENTRY], target: "node", root: join(import.meta.dir, "..", "..", "..") });
  expect(result.success).toBe(true);
  bundle = await result.outputs[0]!.text();
});

describe("the runner bundle", () => {
  it("holds only runner-side modules", () => {
    const modules = [...bundle.matchAll(/^\/\/ (\S+\.(?:ts|tsx|js|mjs))$/gm)].map((match) => match[1]!);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((path) => !ALLOWED_MODULES.some((rule) => rule.test(path)))).toEqual([]);
  });

  it("holds no database client, backend module or validation library", () => {
    expect(FORBIDDEN_TEXT.filter((text) => bundle.includes(text))).toEqual([]);
  });

  it("imports only Node built-ins", () => {
    const imports = [...bundle.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]!);
    expect(imports.filter((spec) => !spec.startsWith("node:"))).toEqual([]);
  });
});
