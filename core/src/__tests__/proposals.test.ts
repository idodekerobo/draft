import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { listProposals, parseProposal, acceptProposal, rejectProposal } from "../proposals";

const TMP = `/tmp/draft-core-proposals-test-${Date.now()}`;
const PROPOSALS_DIR = join(TMP, "proposals");
const ACCEPTED_DIR  = join(TMP, "accepted");
const REJECTED_DIR  = join(TMP, "rejected");

const VALID_PROPOSAL = `---
source: granola
created_at: 2026-05-27T09:15:00Z
summary: Add pricing decision context
---

## Pricing decision

We decided to go with a freemium model.
`;

const NO_FRONTMATTER = `This proposal has no frontmatter at all.`;

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
    expect(p.body).toBe(NO_FRONTMATTER);
  });

  it("returns minimal shell for unreadable file (non-existent path)", () => {
    const p = parseProposal("ghost.md", "/nonexistent/ghost.md");
    expect(p.filename).toBe("ghost.md");
    expect(p.source).toBe("unknown");
    expect(p.body).toBe("");
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
      source: "unknown", createdAt: "", summary: "", body: "" };
    expect(() => acceptProposal(ghost, ACCEPTED_DIR)).toThrow();
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
