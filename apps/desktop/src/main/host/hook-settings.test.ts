import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { hookScript, hookSettings, writeSessionSettings } from "./hook-settings";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("hook settings", () => {
  it("holds the permission hook for an hour and the Stop hook for a short time", () => {
    const settings = hookSettings("/h/hook.sh", "s-1");
    expect(settings.hooks.PermissionRequest[0]!.hooks[0]).toEqual({ type: "command", command: "'/h/hook.sh' 's-1' permission", timeout: 3600 });
    expect(settings.hooks.Stop[0]!.hooks[0]).toMatchObject({ command: "'/h/hook.sh' 's-1' stop", timeout: 30 });
    expect(settings.hooks.SessionStart[0]!.hooks[0]).toMatchObject({ command: "'/h/hook.sh' 's-1' session-start", timeout: 30 });
    expect(settings.hooks.MessageDisplay[0]!.hooks[0]).toMatchObject({ command: "'/h/hook.sh' 's-1' message", timeout: 5 });
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
    expect(script).toContain('>> "$dir/$1.deltas"');
  });

  it("appends a message chunk to a file and never calls the server", () => {
    const script = hookScript();
    expect(script.indexOf('"$2" = message')).toBeLessThan(script.indexOf("curl"));
  });

  describe("running the script", () => {
    function runScript(home: string, payload: string) {
      const scriptPath = join(home, "hook.sh");
      writeFileSync(scriptPath, hookScript());
      return spawnSync("sh", [scriptPath, "s-1", "message"], { env: { ...process.env, HOME: home }, input: payload });
    }

    it("appends one parseable line per message and exits 0", () => {
      const home = mkdtempSync(join(tmpdir(), "hook-home-"));
      dirs.push(home);
      const payload = { session_id: "n1", message_id: "m1", index: 0, final: false, delta: "hi\nthere" };
      const result = runScript(home, JSON.stringify(payload, null, 2));
      expect(result.status).toBe(0);
      const lines = readFileSync(join(home, ".draft/host/hooks/s-1.deltas"), "utf8").split("\n").filter(Boolean);
      expect(lines.map((line) => JSON.parse(line))).toEqual([payload]);
    });

    it("keeps up with 200 messages in a loop", () => {
      const home = mkdtempSync(join(tmpdir(), "hook-home-"));
      dirs.push(home);
      const scriptPath = join(home, "hook.sh");
      writeFileSync(scriptPath, hookScript());
      const started = Date.now();
      for (let i = 0; i < 200; i++) {
        const result = spawnSync("sh", [scriptPath, "s-1", "message"], {
          env: { ...process.env, HOME: home },
          input: JSON.stringify({ message_id: "m1", index: i, final: false, delta: `d${i}` }),
        });
        expect(result.status).toBe(0);
      }
      expect(Date.now() - started).toBeLessThan(20_000);
      const lines = readFileSync(join(home, ".draft/host/hooks/s-1.deltas"), "utf8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(200);
      expect(lines.map((line) => JSON.parse(line).index)).toEqual(Array.from({ length: 200 }, (_, i) => i));
    });
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
