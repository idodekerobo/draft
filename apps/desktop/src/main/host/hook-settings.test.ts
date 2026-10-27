import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hookScript, hookSettings, writeSessionSettings } from "./hook-settings";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("hook settings", () => {
  it("holds the permission hook for an hour and the Stop hook for a short time", () => {
    const settings = hookSettings("/h/hook.sh", "s-1");
    expect(settings.hooks.PermissionRequest[0]!.hooks[0]).toEqual({ type: "command", command: "'/h/hook.sh' 's-1' permission", timeout: 3600 });
    expect(settings.hooks.Stop[0]!.hooks[0]).toMatchObject({ command: "'/h/hook.sh' 's-1' stop", timeout: 30 });
    expect(settings.hooks.SessionStart[0]!.hooks[0]).toMatchObject({ command: "'/h/hook.sh' 's-1' session-start", timeout: 30 });
  });

  it("quotes a path with a quote or a space", () => {
    const settings = hookSettings("/Users/o'neil/my host/hook.sh", "s-1");
    expect(settings.hooks.Stop[0]!.hooks[0]!.command).toBe(`'/Users/o'\\''neil/my host/hook.sh' 's-1' stop`);
  });

  it("the script fails closed so Claude shows its own dialog", () => {
    const script = hookScript();
    expect(script).toContain("|| exit 1");
    expect(script).toContain("--fail");
    expect(script).toContain('"$dir/$1.port"');
  });

  it("writes an executable script and a settings file for the session", () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-settings-"));
    dirs.push(dir);
    const path = writeSessionSettings("s-1", dir);
    expect(path).toBe(`${dir}/settings/s-1.json`);
    expect(JSON.parse(readFileSync(path, "utf8")).hooks.PermissionRequest).toBeDefined();
    expect(statSync(`${dir}/hook.sh`).mode & 0o111).not.toBe(0);
  });
});
