import { beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "sandbox", "host.ts");

// The host runs in a sandbox. It holds the core host code and its own files, never the backend's database or the desktop app.
const ALLOWED_MODULES = [/^\.\.\/core\/src\/.+\.ts$/, /^src\/sandbox\/host(\/.+)?\.ts$/];
const FORBIDDEN_TEXT = ["@supabase", "serviceClient", "SUPABASE_SERVICE_ROLE_KEY", "apps/desktop", "electrobun"];

let bundle = "";

beforeAll(async () => {
  const result = await Bun.build({ entrypoints: [ENTRY], target: "bun", root: join(import.meta.dir, "..", "..", "..") });
  expect(result.success).toBe(true);
  bundle = await result.outputs[0]!.text();
});

describe("the sandbox host bundle", () => {
  it("holds only host-side modules", () => {
    const modules = [...bundle.matchAll(/^\/\/ (\S+\.(?:ts|tsx|js|mjs))$/gm)].map((match) => match[1]!);
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((path) => !ALLOWED_MODULES.some((rule) => rule.test(path)))).toEqual([]);
  });

  it("holds no database client, backend service key or desktop app code", () => {
    expect(FORBIDDEN_TEXT.filter((text) => bundle.includes(text))).toEqual([]);
  });

  it("imports only runtime built-ins", () => {
    const imports = [...bundle.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1]!);
    const builtins = new Set(["fs", "path", "os", "crypto", "zlib", "node:fs", "node:path", "node:os", "node:crypto", "node:zlib", "bun"]);
    expect(imports.filter((spec) => !builtins.has(spec) && !spec.startsWith("bun:") && !spec.startsWith("node:"))).toEqual([]);
  });
});
