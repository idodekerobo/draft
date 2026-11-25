import { beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ENTRY = join(import.meta.dir, "..", "..", "sandbox", "host.ts");

// The host runs in a sandbox. It holds the core host code and its own files, never the backend's database or the desktop app.
const ALLOWED_MODULES = [/^core\/src\/.+\.ts$/, /^backend\/src\/sandbox\/host(\/.+)?\.ts$/];
const FORBIDDEN_TEXT = ["@supabase", "serviceClient", "SUPABASE_SERVICE_ROLE_KEY", "apps/desktop", "electrobun"];

let bundle = "";

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), "draft-bun-bundle-"));
  try {
    const output = join(directory, "bundle.mjs");
    const process = Bun.spawn([Bun.which("bun")!, "build", ENTRY, "--target=bun", "--outfile", output], {
      cwd: join(import.meta.dir, "..", "..", "..", ".."), stdout: "pipe", stderr: "pipe",
    });
    const [exit, diagnostics] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect(exit, diagnostics).toBe(0);
    bundle = readFileSync(output, "utf8");
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
