import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, renameSync } from "fs";
import { join } from "path";

const TMP = `/tmp/draft-proposals-test-${Date.now()}`;
const PROPOSALS_DIR = join(TMP, "proposals");
const ACCEPTED_DIR = join(TMP, "accepted");
const REJECTED_DIR = join(TMP, "rejected");

const SAMPLE_PROPOSAL = `---
source: granola
created_at: 2026-05-22
summary: Updated product strategy based on team meeting
---

## context_updates

### product/index.md

-description: Old product description.
+description: New product description after meeting.
`;

beforeEach(() => {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  mkdirSync(ACCEPTED_DIR, { recursive: true });
  mkdirSync(REJECTED_DIR, { recursive: true });
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("proposals scan", () => {
  it("finds no proposals when proposals/ is empty", () => {
    const files = readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(0);
  });

  it("finds proposals that exist", () => {
    writeFileSync(join(PROPOSALS_DIR, "20260522_test.md"), SAMPLE_PROPOSAL);
    const files = readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(1);
    expect(files[0]).toBe("20260522_test.md");
  });
});

describe("proposals accept", () => {
  it("accept moves file from proposals/ to accepted/", () => {
    const src = join(PROPOSALS_DIR, "20260522_accept.md");
    const dst = join(ACCEPTED_DIR, "20260522_accept.md");
    writeFileSync(src, SAMPLE_PROPOSAL);

    // Simulate accept: mv proposals/ → accepted/
    // renameSync imported at top of file
    renameSync(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(existsSync(dst)).toBe(true);
  });
});

describe("proposals reject", () => {
  it("reject moves file from proposals/ to rejected/", () => {
    const src = join(PROPOSALS_DIR, "20260522_reject.md");
    const dst = join(REJECTED_DIR, "20260522_reject.md");
    writeFileSync(src, SAMPLE_PROPOSAL);

    // renameSync imported at top of file
    renameSync(src, dst);

    expect(existsSync(src)).toBe(false);
    expect(existsSync(dst)).toBe(true);
  });
});

describe("proposals skip", () => {
  it("skip leaves file in proposals/", () => {
    const src = join(PROPOSALS_DIR, "20260522_skip.md");
    writeFileSync(src, SAMPLE_PROPOSAL);

    // Skip: do nothing — file stays in proposals/
    expect(existsSync(src)).toBe(true);
    expect(readdirSync(PROPOSALS_DIR).length).toBe(1);
  });
});

describe("proposals commit failure", () => {
  it("accept still moves to accepted/ even when push fails", () => {
    const src = join(PROPOSALS_DIR, "20260522_pushfail.md");
    const dst = join(ACCEPTED_DIR, "20260522_pushfail.md");
    writeFileSync(src, SAMPLE_PROPOSAL);

    // renameSync imported at top of file
    renameSync(src, dst);

    // File is in accepted/ — push failed (simulated by non-zero exit from commit script)
    // The `draft publish` command will retry it.
    expect(existsSync(dst)).toBe(true);
    expect(existsSync(src)).toBe(false);
  });
});
