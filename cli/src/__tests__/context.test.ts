import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { createMockBackend } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

let backend: ReturnType<typeof createMockBackend>;
let home: string;

beforeEach(() => {
  backend = createMockBackend();
  home = makeHome();
  seedCliAuth(home);
});
afterEach(() => {
  backend.stop();
  rmSync(home, { recursive: true, force: true });
});

function docs(entries: Record<string, string>): Record<string, { content: string }> {
  const out: Record<string, { content: string }> = {};
  for (const [path, content] of Object.entries(entries)) out[path] = { content };
  return out;
}

describe("draft context list", () => {
  test("lexical order, human mode — one name per line", async () => {
    backend.state.contextResponse = () => Response.json({
      versionId: "v1", versionNumber: 1, contentHash: "h", creationReason: "synthesis", createdAt: "2026-01-01T00:00:00.000Z",
      documents: docs({ "team/index.md": "team", "product/index.md": "product", "company/index.md": "company" }),
    });
    const result = await runCli(["context", "list"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("company\nproduct\nteam");
  });

  test("JSON mode — schema_version, names + logical paths, no ANSI", async () => {
    backend.state.contextResponse = () => Response.json({
      versionId: "v1", versionNumber: 1, contentHash: "h", creationReason: "synthesis", createdAt: "2026-01-01T00:00:00.000Z",
      documents: docs({ "product/index.md": "p" }),
    });
    const result = await runCli(["context", "list", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\x1b[");
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, dimensions: [{ name: "product", path: "product/index.md" }] });
  });

  test("arbitrary custom dimension names are discovered", async () => {
    backend.state.contextResponse = () => Response.json({
      versionId: "v1", versionNumber: 1, contentHash: "h", creationReason: "synthesis", createdAt: "x",
      documents: docs({ "roadmap-2027/index.md": "r" }),
    });
    const result = await runCli(["context", "list", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout).dimensions).toEqual([{ name: "roadmap-2027", path: "roadmap-2027/index.md" }]);
  });

  test("ignores logs, decisions, tensions, root/standalone docs, and near-matches", async () => {
    backend.state.contextResponse = () => Response.json({
      versionId: "v1", versionNumber: 1, contentHash: "h", creationReason: "synthesis", createdAt: "x",
      documents: docs({
        "product/index.md": "p",
        "product/log/20260101_note.md": "note",
        "decisions/2026-01-01-thing.md": "decision",
        "tensions/index.md/not-real.md": "nope",
        "README.md": "root doc",
        "product/index.md.bak": "near miss",
        "index.md": "standalone",
      }),
    });
    const result = await runCli(["context", "list", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(result.stdout).dimensions).toEqual([{ name: "product", path: "product/index.md" }]);
  });

  test("empty snapshot reports no dimensions found, never invents defaults", async () => {
    backend.state.contextResponse = () => Response.json({
      versionId: "v1", versionNumber: 1, contentHash: "h", creationReason: "synthesis", createdAt: "x", documents: {},
    });
    const human = await runCli(["context", "list"], { home, apiUrl: backend.url });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("No dimensions found.");
    const json = await runCli(["context", "list", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(json.stdout).dimensions).toEqual([]);
  });

  test("unexpected argument is invalid usage, exit 2", async () => {
    const result = await runCli(["context", "list", "extra"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("no_workspace surfaces onboarding guidance", async () => {
    backend.state.whoamiResponse = () => Response.json({ organization_id: null, primary_team_id: null, workspace_id: null, onboarding_completed_at: null });
    const result = await runCli(["context", "list", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "no_workspace" });
  });

  test("protected command fails immediately when unauthenticated — no hang on closed stdin", async () => {
    const bareHome = makeHome();
    try {
      const result = await runCli(["context", "list", "--json"], { home: bareHome, apiUrl: backend.url, timeoutMs: 5_000 });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "not_authenticated", action: "draft auth login" });
    } finally {
      rmSync(bareHome, { recursive: true, force: true });
    }
  });
});

describe("draft context read", () => {
  beforeEach(() => {
    backend.state.contextResponse = () => Response.json({
      versionId: "v2", versionNumber: 2, contentHash: "hash2", creationReason: "synthesis", createdAt: "2026-01-02T00:00:00.000Z",
      documents: docs({
        "product/index.md": "# Product\ncontent here",
        "company/index.md": "# Company\ninfo",
        "team/index.md": "# Team\ninfo",
      }),
    });
  });

  test("missing selector is invalid usage, exits 2, points to `draft context list`", async () => {
    const result = await runCli(["context", "read"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("draft context list");
  });

  test("--dimension and --all are mutually exclusive", async () => {
    const result = await runCli(["context", "read", "--dimension", "product", "--all"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("rejects unknown flags", async () => {
    const result = await runCli(["context", "read", "--dimension", "product", "--wat"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("rejects positional dimension names", async () => {
    const result = await runCli(["context", "read", "product"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("validates lowercase [a-z0-9-]+ selector values", async () => {
    const result = await runCli(["context", "read", "--dimension", "Product!"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("deduplicates repeated --dimension values, preserving first-request order", async () => {
    const result = await runCli(["context", "read", "--dimension", "team", "--dimension", "product", "--dimension", "team", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.documents.map((d: { name: string }) => d.name)).toEqual(["team", "product"]);
  });

  test("single dimension human read prints exact raw content, no wrapper", async () => {
    const result = await runCli(["context", "read", "--dimension", "product"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("# Product\ncontent here");
  });

  test("multiple dimensions human read uses explicit boundaries in requested order", async () => {
    const result = await runCli(["context", "read", "--dimension", "team", "--dimension", "company"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("===== team/index.md =====\n# Team\ninfo\n===== company/index.md =====\n# Company\ninfo");
  });

  test("--all selects all dimensions in lexical order", async () => {
    const result = await runCli(["context", "read", "--all", "--json"], { home, apiUrl: backend.url });
    const body = JSON.parse(result.stdout);
    expect(body.documents.map((d: { name: string }) => d.name)).toEqual(["company", "product", "team"]);
  });

  test("JSON read preserves snapshot version metadata and only selected entries", async () => {
    const result = await runCli(["context", "read", "--dimension", "product", "--json"], { home, apiUrl: backend.url });
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ schema_version: 1, versionId: "v2", versionNumber: 2, contentHash: "hash2", creationReason: "synthesis", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(body.documents).toEqual([{ name: "product", path: "product/index.md", content: "# Product\ncontent here", sha256: undefined }]);
  });

  test("unknown dimension: atomic failure — no content, all missing + all available names, exit 1", async () => {
    const result = await runCli(["context", "read", "--dimension", "product", "--dimension", "nonexistent", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ status: "error", code: "unknown_dimension", missing: ["nonexistent"] });
    expect(body.available.sort()).toEqual(["company", "product", "team"]);
    expect(result.stdout).not.toContain("content here");
  });

  test("empty snapshot: --all reports no dimensions without inventing content", async () => {
    backend.state.contextResponse = () => Response.json({ versionId: "v3", versionNumber: 3, contentHash: "h3", creationReason: "synthesis", createdAt: "x", documents: {} });
    const human = await runCli(["context", "read", "--all"], { home, apiUrl: backend.url });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("No dimensions found.");
  });

  test("empty snapshot: named read reports empty available set", async () => {
    backend.state.contextResponse = () => Response.json({ versionId: "v3", versionNumber: 3, contentHash: "h3", creationReason: "synthesis", createdAt: "x", documents: {} });
    const result = await runCli(["context", "read", "--dimension", "product", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body.available).toEqual([]);
  });
});
