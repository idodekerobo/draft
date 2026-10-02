import { describe, expect, test } from "bun:test";
import { buildSummarizationBundle } from "../../summarization/build-bundle";
import { recomputeBundleHash } from "../../sandbox/claude-code/runner";

describe("buildSummarizationBundle", () => {
  test("assembles a manifest and one rendered prompt file per session", () => {
    const bundle = buildSummarizationBundle({
      organizationId: "org-1",
      workspaceId: "workspace-1",
      runId: "summarize:workspace-1:fixed-uuid",
      sessions: [
        { session: { id: "session-a" }, transcript: "transcript A" },
        { session: { id: "session-b" }, transcript: "transcript B" },
      ],
    });

    expect(bundle.runId).toBe("summarize:workspace-1:fixed-uuid");
    expect(bundle.manifestPath).toBe("input/manifest.json");
    expect(bundle.files["input/sessions/session-a/prompt.md"].content).toContain("transcript A");
    expect(bundle.files["input/sessions/session-b/prompt.md"].content).toContain("transcript B");

    const manifest = JSON.parse(bundle.files["input/manifest.json"].content);
    expect(manifest).toEqual([
      { id: "session-a", promptPath: "input/sessions/session-a/prompt.md" },
      { id: "session-b", promptPath: "input/sessions/session-b/prompt.md" },
    ]);
  });

  test("mints a summarize:<workspaceId>:<uuid> run id when none is supplied", () => {
    const bundle = buildSummarizationBundle({
      organizationId: "org-1",
      workspaceId: "workspace-1",
      sessions: [{ session: { id: "session-a" }, transcript: "t" }],
    });
    expect(bundle.runId).toMatch(/^summarize:workspace-1:[0-9a-f-]{36}$/);
  });

  test("rejects an empty session list", () => {
    expect(() =>
      buildSummarizationBundle({ organizationId: "org-1", workspaceId: "workspace-1", sessions: [] }),
    ).toThrow("at least one session");
  });

  test("bundle hash matches the hash the sandbox runner recomputes", () => {
    const bundle = buildSummarizationBundle({
      organizationId: "org-1",
      workspaceId: "workspace-1",
      sessions: [
        { session: { id: "session-b" }, transcript: "B" },
        { session: { id: "session-a" }, transcript: "A" },
      ],
    });
    const files = Object.fromEntries(
      Object.entries(bundle.files).map(([path, file]) => [path, file.content]),
    );
    const reserved = new Set(["input/prompt.md", "input/output-schema.json"]);
    expect(recomputeBundleHash(files, reserved)).toBe(bundle.bundleHash);
  });

  test("bundle hash is deterministic and content-sensitive", () => {
    const build = (transcript: string) =>
      buildSummarizationBundle({
        organizationId: "org-1",
        workspaceId: "workspace-1",
        runId: "fixed",
        sessions: [{ session: { id: "session-a" }, transcript }],
      });
    expect(build("a").bundleHash).toBe(build("a").bundleHash);
    expect(build("a").bundleHash).not.toBe(build("b").bundleHash);
  });
});
