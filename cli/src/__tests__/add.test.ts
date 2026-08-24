import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCli, makeHome } from "./helpers/cli-runner.ts";

let home: string;
let project: string;

beforeEach(() => {
  home = makeHome();
  project = mkdtempSync(join(tmpdir(), "draft-add-project-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("draft add — usage errors", () => {
  test("missing tool exits 2", async () => {
    const result = await runCli(["add"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(2);
  });

  test("unknown tool exits 2", async () => {
    const result = await runCli(["add", "notatool", "--dir", project], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(2);
  });

  test("--dir omitted with no TTY (closed stdin) fails immediately, exit 2, no hang", async () => {
    const result = await runCli(["add", "claude-code"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--dir");
  });

  test("--dir omitted with no TTY in --json mode reports invalid_usage", async () => {
    const result = await runCli(["add", "claude-code", "--json"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 1, status: "error", code: "invalid_usage" });
  });

  test("unknown flag exits 2", async () => {
    const result = await runCli(["add", "claude-code", "--nope"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(2);
  });
});

describe("draft add — tool-to-file mapping", () => {
  const cases: [string, string][] = [
    ["claude-code", "CLAUDE.md"],
    ["codex", "AGENTS.md"],
    ["cursor", "AGENTS.md"],
    ["openclaw", "AGENTS.md"],
    ["hermes", "HERMES.md"],
  ];

  for (const [tool, file] of cases) {
    test(`${tool} writes ${file}`, async () => {
      const result = await runCli(["add", tool, "--dir", project], { home, apiUrl: "http://unused" });
      expect(result.exitCode).toBe(0);
      const content = readFileSync(join(project, file), "utf8");
      expect(content).toContain("draft:begin");
      expect(content).toContain("draft context list");
      expect(content).toContain("draft:end");
    });

    test(`${tool} writes the hosted-integrations subsection to ${file}`, async () => {
      const result = await runCli(["add", tool, "--dir", project], { home, apiUrl: "http://unused" });
      expect(result.exitCode).toBe(0);
      const content = readFileSync(join(project, file), "utf8");
      expect(content).toContain("### Hosted integrations");
      expect(content).toContain("draft integrations list");
      expect(content).toContain("draft integrations connect <github|linear|slack|fireflies|claude-code>");
      expect(content).toContain("draft integrations disconnect <github|linear|slack|fireflies>");
    });
  }
});

describe("draft add — directory validation", () => {
  test("missing directory fails with directory_not_found, exit 1", async () => {
    const missing = join(project, "does-not-exist");
    const result = await runCli(["add", "claude-code", "--dir", missing, "--json"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.results[0]).toMatchObject({ ok: false, code: "directory_not_found" });
  });

  test("path that is a file, not a directory, fails with not_a_directory", async () => {
    const filePath = join(project, "notadir");
    writeFileSync(filePath, "x");
    const result = await runCli(["add", "claude-code", "--dir", filePath, "--json"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ ok: false, code: "not_a_directory" });
  });

  test("symlinked instruction-file target is rejected", async () => {
    const realFile = join(project, "real.md");
    writeFileSync(realFile, "hello");
    symlinkSync(realFile, join(project, "CLAUDE.md"));
    const result = await runCli(["add", "claude-code", "--dir", project, "--json"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ ok: false, code: "symlink_target" });
  });

  test("repeated --dir writes to each directory", async () => {
    const projectB = mkdtempSync(join(tmpdir(), "draft-add-project-b-"));
    try {
      const result = await runCli(["add", "claude-code", "--dir", project, "--dir", projectB], { home, apiUrl: "http://unused" });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toContain("draft:begin");
      expect(readFileSync(join(projectB, "CLAUDE.md"), "utf8")).toContain("draft:begin");
    } finally {
      rmSync(projectB, { recursive: true, force: true });
    }
  });
});

describe("draft add — managed block idempotency and user content preservation", () => {
  test("preserves user-authored content outside the managed block, byte-for-byte", async () => {
    const filePath = join(project, "CLAUDE.md");
    const userContent = "# My Project\n\nSome instructions here.\n";
    writeFileSync(filePath, userContent);

    const result = await runCli(["add", "claude-code", "--dir", project], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(0);
    const after = readFileSync(filePath, "utf8");
    expect(after.startsWith(userContent.trimEnd())).toBe(true);
    expect(after).toContain("draft:begin");
  });

  test("second run with no changes needed makes no write (file byte-identical)", async () => {
    const filePath = join(project, "CLAUDE.md");
    await runCli(["add", "claude-code", "--dir", project], { home, apiUrl: "http://unused" });
    const firstContent = readFileSync(filePath, "utf8");

    const result = await runCli(["add", "claude-code", "--dir", project, "--json"], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).results[0]).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(filePath, "utf8")).toBe(firstContent);
  });

  test("rerun replaces the block rather than duplicating it", async () => {
    await runCli(["add", "claude-code", "--dir", project], { home, apiUrl: "http://unused" });
    await runCli(["add", "claude-code", "--dir", project], { home, apiUrl: "http://unused" });
    const content = readFileSync(join(project, "CLAUDE.md"), "utf8");
    expect(content.split("draft:begin").length - 1).toBe(1);
  });

  test("codex then cursor converge on one shared AGENTS.md block, no duplication, no unnecessary write", async () => {
    const codexResult = await runCli(["add", "codex", "--dir", project], { home, apiUrl: "http://unused" });
    expect(codexResult.exitCode).toBe(0);
    const afterCodex = readFileSync(join(project, "AGENTS.md"), "utf8");

    const cursorResult = await runCli(["add", "cursor", "--dir", project, "--json"], { home, apiUrl: "http://unused" });
    expect(cursorResult.exitCode).toBe(0);
    const afterCursor = readFileSync(join(project, "AGENTS.md"), "utf8");

    expect(afterCursor).toBe(afterCodex);
    expect(afterCursor.split("draft:begin").length - 1).toBe(1);
    expect(JSON.parse(cursorResult.stdout).results[0]).toMatchObject({ ok: true, changed: false });
  });
});

describe("draft add — no global configuration or daemon side effects", () => {
  test("does not touch HOME at all", async () => {
    const result = await runCli(["add", "claude-code", "--dir", project], { home, apiUrl: "http://unused" });
    expect(result.exitCode).toBe(0);
    // No files under HOME are created by `draft add` — home was seeded empty by makeHome().
    const { readdirSync } = await import("fs");
    expect(readdirSync(home)).toEqual([]);
  });
});
