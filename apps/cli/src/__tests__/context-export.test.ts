import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { strToU8, zipSync } from "fflate";
import { createMockBackend } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

let backend: ReturnType<typeof createMockBackend>;
let home: string;
let work: string;

function zipOf(files: Record<string, string>): Response {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return new Response(zipSync(entries), { headers: { "content-type": "application/zip" } });
}

const goodZip = () => zipOf({
  "draft-context/README.md": "readme",
  "draft-context/draft-export.json": JSON.stringify({ versionNumber: 5 }),
  "draft-context/company/index.md": "acme",
  "draft-context/memory/2026-10.md": "remember",
});

beforeEach(() => {
  backend = createMockBackend();
  home = makeHome();
  work = mkdtempSync(join(tmpdir(), "draft-cli-export-"));
  seedCliAuth(home);
});
afterEach(() => {
  backend.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const run = (args: string[]) => runCli(["context", "export", ...args], { home, apiUrl: backend.url, cwd: work });

describe("draft context export", () => {
  test("extracts into ./draft-context by default, memory included", async () => {
    backend.state.contextExportResponse = goodZip;
    const result = await run([]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(work, "draft-context", "company", "index.md"), "utf8")).toBe("acme");
    expect(readFileSync(join(work, "draft-context", "memory", "2026-10.md"), "utf8")).toBe("remember");
    expect(result.stdout).toContain("Exported 4 files (version 5)");
  });

  test("--json prints path, fileCount and versionNumber", async () => {
    backend.state.contextExportResponse = goodZip;
    const result = await run(["--json", "--out", join(work, "out")]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: 1,
      path: join(work, "out"),
      fileCount: 4,
      versionNumber: 5,
    });
  });

  test("refuses a non-empty folder without --force", async () => {
    backend.state.contextExportResponse = goodZip;
    const dir = join(work, "out");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep.txt"), "mine");
    const refused = await run(["--out", dir]);
    expect(refused.exitCode).toBe(1);
    expect(readdirSync(dir)).toEqual(["keep.txt"]);

    const forced = await run(["--out", dir, "--force"]);
    expect(forced.exitCode).toBe(0);
    expect(existsSync(join(dir, "company", "index.md"))).toBe(true);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
  });

  test("a malicious entry writes nothing", async () => {
    backend.state.contextExportResponse = () => zipOf({
      "draft-context/company/index.md": "ok",
      "draft-context/../../evil.md": "bad",
    });
    const dir = join(work, "out");
    const result = await run(["--out", dir, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe("unsafe_entry");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(work, "evil.md"))).toBe(false);
  });

  test("rejects backslash and absolute entries", async () => {
    for (const name of ["draft-context/a\\b.md", "/abs.md", "other/x.md"]) {
      backend.state.contextExportResponse = () => zipOf({ [name]: "x" });
      const result = await run(["--out", join(work, "out"), "--json"]);
      expect(JSON.parse(result.stdout).code).toBe("unsafe_entry");
    }
    expect(existsSync(join(work, "out"))).toBe(false);
  });

  test("--zip saves the zip as is", async () => {
    backend.state.contextExportResponse = goodZip;
    const file = join(work, "brain.zip");
    const result = await run(["--zip", file]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(file).byteLength).toBeGreaterThan(0);
    expect(existsSync(join(work, "draft-context"))).toBe(false);

    const again = await run(["--zip", file, "--json"]);
    expect(again.exitCode).toBe(1);
    expect(JSON.parse(again.stdout).code).toBe("file_exists");
  });

  test("--out and --zip are mutually exclusive", async () => {
    const result = await run(["--out", "a", "--zip", "b.zip"]);
    expect(result.exitCode).toBe(2);
  });

  test("no context yet", async () => {
    const result = await run(["--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe("no_context");
  });

  test("not signed in", async () => {
    rmSync(join(home, ".draft"), { recursive: true, force: true });
    const result = await run(["--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe("not_authenticated");
  });
});
