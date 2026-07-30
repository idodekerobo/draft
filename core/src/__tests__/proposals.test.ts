import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  acknowledgeFlaggedProposal,
  applyProposalLocally,
  dismissFlaggedProposal,
  listProposals,
  parseProposal,
  acceptProposal,
  proposalArchiveDirs,
  rejectProposal,
} from "../proposals";

const TMP = `/tmp/draft-core-proposals-test-${Date.now()}`;
const PROPOSALS_DIR = join(TMP, "proposals");
const ACCEPTED_DIR  = join(PROPOSALS_DIR, "accepted");
const REJECTED_DIR  = join(PROPOSALS_DIR, "rejected");

const VALID_PROPOSAL = `---
source: granola
created_at: 2026-05-27T09:15:00Z
summary: Add pricing decision context
---

## Pricing decision

We decided to go with a freemium model.
`;

const DESKTOP_PROPOSAL = `---
dimension: product
action: update
source: slack
synthesized_by: draft:synthesize
timestamp: 2026-05-27T09:15:00Z
---

# Product

Updated content.
`;

const NO_FRONTMATTER = `This proposal has no frontmatter at all.`;
const FLAGGED_PROPOSAL = `---
outcome: needs_input
needs_input_reason: Confirm whether the old or new roadmap is authoritative.
source: claude-code
timestamp: 2026-05-27T09:15:00Z
summary: Automated maintainer needs input
context_updates:
  - file: context/product/index.md
    action: overwrite
    content: unsafe rewrite
---

# Human review required
`;

beforeEach(() => {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── listProposals ───────────────────────────────────────────────────────────────

describe("listProposals", () => {
  it("returns empty array when proposals/ dir does not exist", () => {
    const result = listProposals("/nonexistent/workspace");
    expect(result).toEqual([]);
  });

  it("returns empty array when proposals/ dir is empty", () => {
    const result = listProposals(TMP);
    expect(result).toEqual([]);
  });

  it("ignores non-.md files", () => {
    writeFileSync(join(PROPOSALS_DIR, "notes.txt"), "ignored");
    const result = listProposals(TMP);
    expect(result).toHaveLength(0);
  });

  it("returns one proposal for a single .md file", () => {
    writeFileSync(join(PROPOSALS_DIR, "20260527_granola.md"), VALID_PROPOSAL);
    const result = listProposals(TMP);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("20260527_granola.md");
  });

  it("returns proposals sorted oldest-first by mtime", async () => {
    writeFileSync(join(PROPOSALS_DIR, "older.md"), VALID_PROPOSAL);
    // small delay so mtime differs
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(PROPOSALS_DIR, "newer.md"), VALID_PROPOSAL);
    const result = listProposals(TMP);
    expect(result[0].filename).toBe("older.md");
    expect(result[1].filename).toBe("newer.md");
  });

  it("includes flagged/*.md with a stable relative ID", () => {
    const flaggedDir = join(PROPOSALS_DIR, "flagged");
    mkdirSync(flaggedDir);
    writeFileSync(join(flaggedDir, "needs-input.md"), FLAGGED_PROPOSAL);

    const result = listProposals(TMP);

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("flagged/needs-input.md");
    expect(result[0].kind).toBe("flagged");
  });
});

// ── parseProposal ───────────────────────────────────────────────────────────────

describe("parseProposal", () => {
  it("parses source, createdAt, summary from valid frontmatter", () => {
    const file = join(PROPOSALS_DIR, "valid.md");
    writeFileSync(file, VALID_PROPOSAL);
    const p = parseProposal("valid.md", file);
    expect(p.source).toBe("granola");
    expect(p.createdAt).toBe("2026-05-27T09:15:00Z");
    expect(p.summary).toBe("Add pricing decision context");
  });

  it("parses desktop proposal metadata from YAML frontmatter", () => {
    const file = join(PROPOSALS_DIR, "desktop.md");
    writeFileSync(file, DESKTOP_PROPOSAL);
    const p = parseProposal("desktop.md", file);
    expect(p.dimension).toBe("product");
    expect(p.action).toBe("update");
    expect(p.source).toBe("slack");
    expect(p.synthesizedBy).toBe("draft:synthesize");
    expect(p.timestamp).toBe("2026-05-27T09:15:00Z");
    expect(p.summary).toBe("update product");
  });

  it("extracts body (content after closing ---)", () => {
    const file = join(PROPOSALS_DIR, "body.md");
    writeFileSync(file, VALID_PROPOSAL);
    const p = parseProposal("body.md", file);
    expect(p.body).toContain("freemium model");
    expect(p.body).not.toContain("---");
  });

  it("falls back to filename as summary when frontmatter is absent", () => {
    const file = join(PROPOSALS_DIR, "no-fm.md");
    writeFileSync(file, NO_FRONTMATTER);
    const p = parseProposal("no-fm.md", file);
    expect(p.summary).toBe("no-fm.md");
    expect(p.source).toBe("unknown");
    expect(p.dimension).toBe("unknown");
    expect(p.body).toBe(NO_FRONTMATTER);
  });

  it("returns minimal shell for unreadable file (non-existent path)", () => {
    const p = parseProposal("ghost.md", "/nonexistent/ghost.md");
    expect(p.filename).toBe("ghost.md");
    expect(p.source).toBe("unknown");
    expect(p.body).toBe("");
  });

  it("parses flagged outcome and needs_input_reason", () => {
    const flaggedDir = join(PROPOSALS_DIR, "flagged");
    mkdirSync(flaggedDir);
    const file = join(flaggedDir, "needs-input.md");
    writeFileSync(file, FLAGGED_PROPOSAL);

    const p = parseProposal("flagged/needs-input.md", file);

    expect(p.kind).toBe("flagged");
    expect(p.outcome).toBe("needs_input");
    expect(p.needsInputReason).toBe("Confirm whether the old or new roadmap is authoritative.");
  });

  it("supports legacy flagged_reason and the body Reason section", () => {
    const flaggedDir = join(PROPOSALS_DIR, "flagged");
    mkdirSync(flaggedDir);
    const file = join(flaggedDir, "stale.md");
    writeFileSync(file, `---
flagged_reason: stale
summary: Stale automated maintainer rewrite
---

# Human review required

## Reason

Product context changed after synthesis.

## Proposed rewrites

None.
`);

    const p = parseProposal("flagged/stale.md", file);

    expect(p.outcome).toBe("stale");
    expect(p.needsInputReason).toBe("Product context changed after synthesis.");
  });
});

// ── acceptProposal ──────────────────────────────────────────────────────────────

describe("acceptProposal", () => {
  it("moves proposal file to accepted/ directory", () => {
    const file = join(PROPOSALS_DIR, "to-accept.md");
    writeFileSync(file, VALID_PROPOSAL);
    const p = parseProposal("to-accept.md", file);
    acceptProposal(p, ACCEPTED_DIR);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(ACCEPTED_DIR, "to-accept.md"))).toBe(true);
  });

  it("creates accepted/ dir if it does not exist", () => {
    const file = join(PROPOSALS_DIR, "auto-dir.md");
    writeFileSync(file, VALID_PROPOSAL);
    const p = parseProposal("auto-dir.md", file);
    const newDir = join(TMP, "accepted-new");
    acceptProposal(p, newDir);
    expect(existsSync(join(newDir, "auto-dir.md"))).toBe(true);
  });

  it("throws when source file does not exist", () => {
    const ghost = { filename: "ghost.md", path: "/nonexistent/ghost.md", mtime: 0,
      kind: "manual" as const, outcome: "", needsInputReason: "",
      source: "unknown", createdAt: "", timestamp: "", dimension: "unknown", action: "update",
      synthesizedBy: "", summary: "", body: "", rawContent: "", content: "", contextUpdates: [] };
    expect(() => acceptProposal(ghost, ACCEPTED_DIR)).toThrow();
  });
});

describe("flagged proposal actions", () => {
  it("cannot apply a context rewrite", () => {
    const flaggedDir = join(PROPOSALS_DIR, "flagged");
    const contextPath = join(TMP, "context", "product", "index.md");
    mkdirSync(flaggedDir);
    mkdirSync(join(TMP, "context", "product"), { recursive: true });
    writeFileSync(contextPath, "original\n");
    const file = join(flaggedDir, "unsafe.md");
    writeFileSync(file, FLAGGED_PROPOSAL);
    const proposal = parseProposal("flagged/unsafe.md", file);

    expect(() => applyProposalLocally(proposal, TMP)).toThrow("cannot apply context updates");
    expect(readFileSync(contextPath, "utf8")).toBe("original\n");
  });

  it("acknowledges into proposals/accepted without applying", () => {
    const flaggedDir = join(PROPOSALS_DIR, "flagged");
    mkdirSync(flaggedDir);
    const file = join(flaggedDir, "ack.md");
    writeFileSync(file, FLAGGED_PROPOSAL);
    const proposal = parseProposal("flagged/ack.md", file);

    acknowledgeFlaggedProposal(proposal, TMP);

    expect(existsSync(join(PROPOSALS_DIR, "accepted", "ack.md"))).toBe(true);
    expect(existsSync(join(TMP, "accepted", "ack.md"))).toBe(false);
  });

  it("dismisses into proposals/rejected", () => {
    const flaggedDir = join(PROPOSALS_DIR, "flagged");
    mkdirSync(flaggedDir);
    const file = join(flaggedDir, "dismiss.md");
    writeFileSync(file, FLAGGED_PROPOSAL);
    const proposal = parseProposal("flagged/dismiss.md", file);

    dismissFlaggedProposal(proposal, TMP);

    expect(existsSync(join(PROPOSALS_DIR, "rejected", "dismiss.md"))).toBe(true);
  });

  it("returns canonical archive directories under proposals/", () => {
    expect(proposalArchiveDirs(TMP)).toEqual({
      accepted: join(TMP, "proposals", "accepted"),
      rejected: join(TMP, "proposals", "rejected"),
    });
  });
});

// ── rejectProposal ──────────────────────────────────────────────────────────────

describe("rejectProposal", () => {
  it("moves proposal file to rejected/ directory", () => {
    const file = join(PROPOSALS_DIR, "to-reject.md");
    writeFileSync(file, VALID_PROPOSAL);
    const p = parseProposal("to-reject.md", file);
    rejectProposal(p, REJECTED_DIR);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(REJECTED_DIR, "to-reject.md"))).toBe(true);
  });

  it("creates rejected/ dir if it does not exist", () => {
    const file = join(PROPOSALS_DIR, "auto-dir-reject.md");
    writeFileSync(file, VALID_PROPOSAL);
    const p = parseProposal("auto-dir-reject.md", file);
    const newDir = join(TMP, "rejected-new");
    rejectProposal(p, newDir);
    expect(existsSync(join(newDir, "auto-dir-reject.md"))).toBe(true);
  });
});
