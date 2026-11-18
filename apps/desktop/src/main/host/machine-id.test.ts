import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDesktopHostId } from "./machine-id";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("getDesktopHostId", () => {
  it("creates an id once and returns the same one afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-"));
    dirs.push(dir);
    const path = join(dir, "nested", "host-id");
    const first = getDesktopHostId(path);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(getDesktopHostId(path)).toBe(first);
  });
});
