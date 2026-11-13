import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import { hostSessionsDir, loadStates, saveState, type HostSessionState } from "./cursor-store";

const state = (sessionId: string): HostSessionState => ({ sessionId, workspaceId: "w", hostMachineId: "h", nativeSessionId: "n", folderPath: "/f", cursors: {}, rawUploads: {}, ended: false });

describe("host sessions folder", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  test("a dev build uses its own folder", () => {
    expect(hostSessionsDir("/home/me", false)).toBe("/home/me/.draft/host/sessions");
    expect(hostSessionsDir("/home/me", true)).toBe("/home/me/.draft/host-dev/sessions");
  });

  test("a dev build does not resume the installed app's sessions", () => {
    const home = mkdtempSync(join(tmpdir(), "cursor-store-"));
    roots.push(home);
    saveState(state("prod-session"), hostSessionsDir(home, false));
    expect(loadStates(hostSessionsDir(home, true))).toEqual([]);
    expect(loadStates(hostSessionsDir(home, false)).map((s) => s.sessionId)).toEqual(["prod-session"]);
  });
});
