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

function skillDetail(overrides: Record<string, unknown> = {}) {
  return {
    name: "email-template",
    description: "Use when drafting outbound partner emails.",
    license: null,
    compatibility: null,
    metadata: null,
    allowedTools: null,
    content: "Dear {{name}},\n\nThanks for...",
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: null,
    ...overrides,
  };
}

describe("draft skills list", () => {
  test("human mode — name and description per line", async () => {
    backend.state.skillsListResponse = () => Response.json({
      skills: [{ name: "email-template", description: "Use when drafting outbound partner emails." }],
    });
    const result = await runCli(["skills", "list"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("email-template");
    expect(result.stdout).toContain("Use when drafting outbound partner emails.");
  });

  test("JSON mode — schema_version, full skill list", async () => {
    backend.state.skillsListResponse = () => Response.json({ skills: [{ name: "a", description: "d" }] });
    const result = await runCli(["skills", "list", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, skills: [{ name: "a", description: "d" }] });
  });

  test("empty workspace reports no skills found", async () => {
    backend.state.skillsListResponse = () => Response.json({ skills: [] });
    const result = await runCli(["skills", "list"], { home, apiUrl: backend.url });
    expect(result.stdout).toBe("No skills found.");
  });
});

describe("draft skills read", () => {
  test("prints full content", async () => {
    backend.state.skillsReadResponse = () => Response.json(skillDetail());
    const result = await runCli(["skills", "read", "email-template"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("email-template");
    expect(result.stdout).toContain("Dear {{name}}");
  });

  test("unknown skill exits with operational error", async () => {
    backend.state.skillsReadResponse = () => Response.json({ error: "skill_not_found" }, { status: 404 });
    const result = await runCli(["skills", "read", "nope"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
  });

  test("missing name is a usage error", async () => {
    const result = await runCli(["skills", "read"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });
});

describe("draft skills add", () => {
  test("--content with explicit name/description", async () => {
    let captured: unknown;
    backend.state.skillsAddResponse = (_ws, body) => {
      captured = body;
      return Response.json(skillDetail(), { status: 201 });
    };
    const result = await runCli(
      ["skills", "add", "email-template", "--description", "Use when drafting outbound partner emails.", "--content", "Dear {{name}},"],
      { home, apiUrl: backend.url },
    );
    expect(result.exitCode).toBe(0);
    expect(captured).toEqual({
      name: "email-template",
      description: "Use when drafting outbound partner emails.",
      content: "Dear {{name}},",
    });
  });

  test("reads content from stdin when no --file/--content given", async () => {
    let captured: unknown;
    backend.state.skillsAddResponse = (_ws, body) => {
      captured = body;
      return Response.json(skillDetail(), { status: 201 });
    };
    const result = await runCli(
      ["skills", "add", "--description", "d"],
      { home, apiUrl: backend.url, stdin: "---\nname: from-stdin\ndescription: ignored\n---\nbody text" },
    );
    expect(result.exitCode).toBe(0);
    expect((captured as { content: string }).content).toContain("body text");
  });

  test("--file and --content together is a usage error", async () => {
    const result = await runCli(
      ["skills", "add", "x", "--description", "d", "--file", "/tmp/does-not-matter.md", "--content", "text"],
      { home, apiUrl: backend.url },
    );
    expect(result.exitCode).toBe(2);
  });

  test("duplicate name surfaces the backend's 409", async () => {
    backend.state.skillsAddResponse = () => Response.json({ error: "duplicate_name" }, { status: 409 });
    const result = await runCli(
      ["skills", "add", "x", "--description", "d", "--content", "text"],
      { home, apiUrl: backend.url },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("draft skills update");
  });

  test("no content anywhere is a usage error, no network call", async () => {
    const result = await runCli(["skills", "add", "x", "--description", "d"], {
      home, apiUrl: backend.url, stdin: "",
    });
    expect(result.exitCode).toBe(2);
  });
});

describe("draft skills update", () => {
  test("missing name is a usage error", async () => {
    const result = await runCli(["skills", "update", "--content", "x"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("not-found passthrough", async () => {
    backend.state.skillsUpdateResponse = () => Response.json({ error: "skill_not_found" }, { status: 404 });
    const result = await runCli(["skills", "update", "missing", "--content", "x"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
  });
});

describe("draft skills remove", () => {
  test("soft-deletes and reports ok", async () => {
    backend.state.skillsRemoveResponse = () => Response.json({ ok: true });
    const result = await runCli(["skills", "remove", "email-template"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Removed skill");
  });

  test("not-found passthrough", async () => {
    backend.state.skillsRemoveResponse = () => Response.json({ error: "skill_not_found" }, { status: 404 });
    const result = await runCli(["skills", "remove", "missing"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
  });
});
