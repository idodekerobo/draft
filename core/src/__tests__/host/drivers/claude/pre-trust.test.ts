import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { preTrustFolder } from "../../../../host/drivers/claude/pre-trust";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "host-"));
  dirs.push(dir);
  return dir;
}

describe("preTrustFolder", () => {
  it("adds the keys and keeps everything else", () => {
    const path = join(tempDir(), ".claude.json");
    writeFileSync(path, JSON.stringify({ theme: "dark", projects: { "/other": { allowedTools: ["x"] } } }));

    preTrustFolder("/work/app", path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      theme: "dark",
      hasCompletedOnboarding: true,
      projects: { "/other": { allowedTools: ["x"] }, "/work/app": { hasTrustDialogAccepted: true } },
    });
  });

  it("keeps existing settings for the same folder", () => {
    const path = join(tempDir(), ".claude.json");
    writeFileSync(path, JSON.stringify({ projects: { "/work/app": { allowedTools: ["x"] } } }));

    preTrustFolder("/work/app", path);

    expect(JSON.parse(readFileSync(path, "utf8")).projects["/work/app"]).toEqual({ allowedTools: ["x"], hasTrustDialogAccepted: true });
  });

  it("creates the file when it does not exist", () => {
    const path = join(tempDir(), ".claude.json");
    preTrustFolder("/work/app", path);
    expect(JSON.parse(readFileSync(path, "utf8")).hasCompletedOnboarding).toBe(true);
  });

  it("refuses to overwrite a file it cannot parse", () => {
    const path = join(tempDir(), ".claude.json");
    writeFileSync(path, "{not json");
    expect(() => preTrustFolder("/work/app", path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});
