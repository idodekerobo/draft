import { describe, expect, it } from "bun:test";
import { validateMaintainerOutput } from "../maintainer";

const HASH = "a".repeat(64);

function document(frontmatter: string, body = ""): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe("validateMaintainerOutput", () => {
  it("accepts no_change and parses optional string metadata", () => {
    const result = validateMaintainerOutput(document(`
outcome: no_change
session_id: session-123
input_source: slack
synthesized_by: maintainer-v1
timestamp: 2026-07-29T12:00:00Z
profile: default`.trim()));

    expect(result).toEqual({
      ok: true,
      output: {
        outcome: "no_change",
        session_id: "session-123",
        input_source: "slack",
        synthesized_by: "maintainer-v1",
        timestamp: "2026-07-29T12:00:00Z",
        profile: "default",
      },
    });
  });

  it("accepts bounded unique meeting receipt IDs", () => {
    expect(validateMaintainerOutput(document(`
outcome: no_change
meeting_ids:
  - meeting-1
  - meeting-2
`))).toEqual({
      ok: true,
      output: {
        outcome: "no_change",
        meeting_ids: ["meeting-1", "meeting-2"],
      },
    });
  });

  it("strictly validates meeting receipt IDs", () => {
    expect(validateMaintainerOutput(document("outcome: no_change\nmeeting_ids: nope"))).toEqual({
      ok: false,
      error: "meeting_ids must be an array",
    });
    // Duplicates are allowed here; mergeGranolaState/mergeFirefliesState collapse them via Set.
    expect(validateMaintainerOutput(document("outcome: no_change\nmeeting_ids:\n  - ok\n  - ok"))).toEqual({
      ok: true,
      output: { outcome: "no_change", meeting_ids: ["ok", "ok"] },
    });
    expect(validateMaintainerOutput(document('outcome: no_change\nmeeting_ids:\n  - "  "'))).toEqual({
      ok: false,
      error: "meeting_ids[0] must be a nonempty string",
    });
  });

  it("accepts needs_input with a nonempty reason", () => {
    expect(validateMaintainerOutput(document(`
outcome: needs_input
needs_input_reason: Confirm which roadmap is current.
`.trim()))).toEqual({
      ok: true,
      output: {
        outcome: "needs_input",
        needs_input_reason: "Confirm which roadmap is current.",
      },
    });
  });

  it("accepts unique rewrites and optional removals", () => {
    const result = validateMaintainerOutput(document(`
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${HASH}
    summary: Consolidate the current roadmap
    content: |
      # Product
      Current roadmap.
    removals:
      - claim: The legacy launch date is active.
        reason: Superseded by the July decision.
  - file: context/priorities/index.md
    base_sha256: ${"b".repeat(64)}
    summary: Refresh active priorities
    content: New priorities
`.trim()));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.outcome).toBe("rewrite");
      if (result.output.outcome === "rewrite") {
        expect(result.output.rewrites).toHaveLength(2);
        expect(result.output.rewrites[0].removals?.[0].claim).toContain("legacy");
      }
    }
  });

  it.each([
    ["no_change with rewrites", "outcome: no_change\nrewrites: []", "no_change outcome forbids rewrites"],
    ["no_change with an empty reason", 'outcome: no_change\nneeds_input_reason: ""', "no_change outcome forbids needs_input_reason"],
    ["needs_input with rewrites", "outcome: needs_input\nneeds_input_reason: Why?\nrewrites: []", "needs_input outcome forbids rewrites"],
    ["rewrite with a reason", `outcome: rewrite\nneeds_input_reason: ""\nrewrites:\n  - file: context/product/index.md\n    base_sha256: ${HASH}\n    summary: Summary\n    content: Content`, "rewrite outcome forbids needs_input_reason"],
  ])("rejects contradictory field presence: %s", (_name, yaml, expected) => {
    const result = validateMaintainerOutput(document(yaml));
    expect(result).toEqual({ ok: false, error: expected });
  });

  it("rejects missing or empty outcome-specific values", () => {
    expect(validateMaintainerOutput(document("outcome: rewrite\nrewrites: []"))).toEqual({
      ok: false,
      error: "rewrites must be a nonempty array",
    });
    expect(validateMaintainerOutput(document('outcome: needs_input\nneeds_input_reason: "  "'))).toEqual({
      ok: false,
      error: "needs_input_reason must be a nonempty string",
    });
  });

  it("rejects an unknown outcome", () => {
    expect(validateMaintainerOutput(document("outcome: delete"))).toEqual({
      ok: false,
      error: 'unknown outcome "delete"',
    });
  });

  it("rejects unknown fields at every contract level", () => {
    expect(validateMaintainerOutput(document("outcome: no_change\njob_id: untrusted"))).toEqual({
      ok: false,
      error: 'unknown top-level field "job_id"',
    });

    expect(validateMaintainerOutput(document(`
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${HASH}
    summary: Summary
    content: Content
    action: overwrite
`.trim()))).toEqual({
      ok: false,
      error: 'rewrites[0] has unknown field "action"',
    });

    expect(validateMaintainerOutput(document(`
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${HASH}
    summary: Summary
    content: Content
    removals:
      - claim: Old claim
        reason: Superseded
        confidence: high
`.trim()))).toEqual({
      ok: false,
      error: 'rewrites[0].removals[0] has unknown field "confidence"',
    });
  });

  it("requires optional metadata values to remain strings", () => {
    expect(validateMaintainerOutput(document("outcome: no_change\nprofile: 42"))).toEqual({
      ok: false,
      error: "profile must be a string",
    });
  });

  it.each([
    "/context/product/index.md",
    "context\\product\\index.md",
    "context/../product/index.md",
    "context/product/../../secrets.md",
    "context/product/notes.md",
    "other/product/index.md",
  ])("rejects unsafe or incorrectly routed path %s", (file) => {
    const result = validateMaintainerOutput(document(`
outcome: rewrite
rewrites:
  - file: ${JSON.stringify(file)}
    base_sha256: ${HASH}
    summary: Summary
    content: Content
`.trim()));
    expect(result).toEqual({
      ok: false,
      error: "rewrites[0].file is not an allowed context index path",
    });
  });

  it("rejects duplicate rewrite targets with an indexed error", () => {
    const result = validateMaintainerOutput(document(`
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${HASH}
    summary: First
    content: First content
  - file: context/product/index.md
    base_sha256: ${"b".repeat(64)}
    summary: Second
    content: Second content
`.trim()));
    expect(result).toEqual({
      ok: false,
      error: 'rewrites[1].file duplicates target "context/product/index.md"',
    });
  });

  it.each([
    ["too short", "a".repeat(63)],
    ["uppercase", "A".repeat(64)],
    ["non-hex", "g".repeat(64)],
  ])("rejects malformed base hashes: %s", (_name, hash) => {
    const result = validateMaintainerOutput(document(`
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${hash}
    summary: Summary
    content: Content
`.trim()));
    expect(result).toEqual({
      ok: false,
      error: "rewrites[0].base_sha256 must be exactly 64 lowercase hexadecimal characters",
    });
  });

  it("returns indexed errors for malformed rewrite and removal entries", () => {
    const rewriteResult = validateMaintainerOutput(document("outcome: rewrite\nrewrites:\n  - nope"));
    expect(rewriteResult).toEqual({
      ok: false,
      error: "rewrites[0] must be an object",
    });

    const removalResult = validateMaintainerOutput(document(`
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${HASH}
    summary: Summary
    content: Content
    removals:
      - claim: ""
        reason: Missing evidence
`.trim()));
    expect(removalResult).toEqual({
      ok: false,
      error: "rewrites[0].removals[0].claim must be a nonempty string",
    });
  });

  it("rejects malformed YAML", () => {
    expect(validateMaintainerOutput(document("outcome: [rewrite"))).toEqual({
      ok: false,
      error: "malformed YAML frontmatter",
    });
  });

  it("rejects output over 1 MB and disallowed control characters", () => {
    expect(validateMaintainerOutput(document(`outcome: no_change\n# ${"a".repeat(1_000_000)}`))).toEqual({
      ok: false,
      error: "maintainer output exceeds 1 MB",
    });
    expect(validateMaintainerOutput(document("outcome: no_change") + "\u0000")).toEqual({
      ok: false,
      error: "maintainer output contains control characters",
    });
  });

  it("does not accept rewrites placed after the closing frontmatter", () => {
    const result = validateMaintainerOutput(document(
      "outcome: rewrite",
      `rewrites:\n  - file: context/product/index.md\n    base_sha256: ${HASH}\n    summary: Hidden\n    content: Hidden`,
    ));
    expect(result).toEqual({
      ok: false,
      error: "rewrites must be a nonempty array",
    });
  });
});
