import { describe, expect, test } from "bun:test";
import {
  parseRunnerFailure,
  parseWorkspaceIdFromSummarizationRunId,
} from "../../summarization/complete-summarization-callback";

describe("parseRunnerFailure", () => {
  test("recognizes the runner's {error, diagnostics} failure body", () => {
    expect(
      parseRunnerFailure({ error: "bundle_fetch_failed", diagnostics: { reason: "hash mismatch" } }),
    ).toEqual({ error: "bundle_fetch_failed", diagnostics: { reason: "hash mismatch" } });
  });

  test("ignores a normal batch result and non-object bodies", () => {
    expect(parseRunnerFailure({ items: [] })).toBeNull();
    expect(parseRunnerFailure({ items: [], error: "x" })).toBeNull();
    expect(parseRunnerFailure(null)).toBeNull();
    expect(parseRunnerFailure([])).toBeNull();
    expect(parseRunnerFailure({})).toBeNull();
  });
});

describe("parseWorkspaceIdFromSummarizationRunId", () => {
  test("extracts the workspace id from a summarize:<workspaceId>:<uuid> run id", () => {
    expect(parseWorkspaceIdFromSummarizationRunId("summarize:workspace-1:uuid-1")).toBe("workspace-1");
  });

  test("returns null for a bare synthesis-style uuid or a malformed prefix", () => {
    expect(parseWorkspaceIdFromSummarizationRunId("55555555-5555-4555-8555-555555555555")).toBeNull();
    expect(parseWorkspaceIdFromSummarizationRunId("summarize:")).toBeNull();
    expect(parseWorkspaceIdFromSummarizationRunId("summarize::uuid-1")).toBeNull();
  });
});
