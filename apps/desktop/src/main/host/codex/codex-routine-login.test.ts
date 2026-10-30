import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ServerError } from "../../server/server-client";
import { cancelRoutineCodexLogin, pollRoutineCodexLogin, startRoutineCodexLogin, type RoutineLoginDeps } from "./codex-routine-login";

const LOGIN = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "r1" } });

function deps(overrides: Partial<RoutineLoginDeps> = {}): RoutineLoginDeps & { homes: string[]; saved: Array<{ workspaceId: string; authJson: string }> } {
  const homes: string[] = [];
  const saved: Array<{ workspaceId: string; authJson: string }> = [];
  return {
    homes,
    saved,
    workspaceId: () => "ws-1",
    save: async (workspaceId, authJson) => void saved.push({ workspaceId, authJson }),
    start: async (_options, home) => {
      homes.push(home);
      return { ok: true };
    },
    ...overrides,
  };
}

afterEach(() => cancelRoutineCodexLogin());

describe("routine Codex login", () => {
  it("signs in in a folder of its own, never the person's own Codex folder", async () => {
    const d = deps();
    await startRoutineCodexLogin({ deviceCode: false }, d);
    expect(d.homes).toHaveLength(1);
    expect(d.homes[0]!.startsWith(join(homedir(), ".codex"))).toBe(false);
    expect(existsSync(d.homes[0]!)).toBe(true);
  });

  it("waits until the login file appears, then saves that file to the workspace and deletes the local copy", async () => {
    const d = deps();
    await startRoutineCodexLogin({ deviceCode: false }, d);
    expect(await pollRoutineCodexLogin(d)).toEqual({ state: "waiting" });

    await writeFile(join(d.homes[0]!, "auth.json"), LOGIN);
    expect(await pollRoutineCodexLogin(d)).toEqual({ state: "connected" });
    expect(d.saved).toEqual([{ workspaceId: "ws-1", authJson: LOGIN }]);
    expect(existsSync(d.homes[0]!)).toBe(false);
    expect(await pollRoutineCodexLogin(d)).toEqual({ state: "idle" });
  });

  it("removes the folder when the sign-in cannot start", async () => {
    const d = deps({ start: async (_options, home) => (d.homes.push(home), { ok: false, error: "Codex is not installed on this computer." }) });
    expect(await startRoutineCodexLogin({ deviceCode: false }, d)).toEqual({ ok: false, error: "Codex is not installed on this computer." });
    expect(existsSync(d.homes[0]!)).toBe(false);
  });

  it("says so, and deletes the login, when the server refuses the file or cannot be reached", async () => {
    const refused = deps({ save: async () => { throw new ServerError("invalid_auth_json"); } });
    await startRoutineCodexLogin({ deviceCode: false }, refused);
    await writeFile(join(refused.homes[0]!, "auth.json"), LOGIN);
    expect(await pollRoutineCodexLogin(refused)).toEqual({ state: "failed", error: "Codex did not give a login that routines can use." });
    expect(existsSync(refused.homes[0]!)).toBe(false);

    const offline = deps({ save: async () => { throw new Error("offline"); } });
    await startRoutineCodexLogin({ deviceCode: false }, offline);
    await writeFile(join(offline.homes[0]!, "auth.json"), LOGIN);
    expect(await pollRoutineCodexLogin(offline)).toEqual({ state: "failed", error: "Could not save the Codex login." });
  });

  it("does not save when the person is not signed in to Draft Cloud", async () => {
    const d = deps({ workspaceId: () => null });
    await startRoutineCodexLogin({ deviceCode: false }, d);
    await writeFile(join(d.homes[0]!, "auth.json"), LOGIN);
    expect(await pollRoutineCodexLogin(d)).toEqual({ state: "failed", error: "Sign in to Draft Cloud first." });
    expect(d.saved).toHaveLength(0);
  });

  it("deletes the folder when the sign-in is cancelled", async () => {
    const d = deps();
    await startRoutineCodexLogin({ deviceCode: false }, d);
    await cancelRoutineCodexLogin();
    expect(existsSync(d.homes[0]!)).toBe(false);
    expect(await pollRoutineCodexLogin(d)).toEqual({ state: "idle" });
  });
});
