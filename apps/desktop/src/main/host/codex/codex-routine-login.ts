import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCachedWorkspaceId } from "draft-core/auth-state";
import { ServerError, fetchServer, fetchServerJSON } from "../../server/server-client";
import { cancelCodexLogin, startCodexLogin, type CodexLoginStart } from "./codex-login";

export type RoutineCodexStatus = { ok: true; status: string | null } | { ok: false; error: string };
export type RoutineCodexPoll = { state: "idle" | "waiting" | "connected" } | { state: "failed"; error: string };

let pendingHome: string | null = null;

export interface RoutineLoginDeps {
  workspaceId(): string | null;
  save(workspaceId: string, authJson: string): Promise<void>;
  start(options: { deviceCode: boolean }, codexHome: string): Promise<CodexLoginStart>;
}

const defaultDeps: RoutineLoginDeps = {
  workspaceId: getCachedWorkspaceId,
  save: async (workspaceId, authJson) => {
    await fetchServer(`workspaces/${workspaceId}/codex-credential`, { method: "PUT", body: JSON.stringify({ auth_json: authJson }) });
  },
  start: startCodexLogin,
};

const NOT_SIGNED_IN = "Sign in to Draft Cloud first.";

/** Whether the workspace has a Codex login for routines. Never reads the login itself. */
export async function getRoutineCodexStatus(): Promise<RoutineCodexStatus> {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) return { ok: false, error: NOT_SIGNED_IN };
  try {
    const body = await fetchServerJSON<{ status: string | null }>(`workspaces/${workspaceId}/codex-credential`);
    return { ok: true, status: body.status };
  } catch {
    return { ok: false, error: "Could not check Codex for routines." };
  }
}

async function discardPending(): Promise<void> {
  const home = pendingHome;
  pendingHome = null;
  if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Signs in to Codex for the workspace's routines. It uses a folder of its own as CODEX_HOME, so it never reads
 * or clears the person's own Codex login. The login made there is a separate one, because a login that two
 * places use would break when either refreshes it.
 */
export async function startRoutineCodexLogin(options: { deviceCode: boolean }, deps: RoutineLoginDeps = defaultDeps): Promise<CodexLoginStart> {
  await discardPending();
  const home = await mkdtemp(join(tmpdir(), "draft-codex-routines-"));
  const started = await deps.start(options, home);
  if (!started.ok) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    return started;
  }
  pendingHome = home;
  return started;
}

/** Looks for the finished login. When it is there, saves it to the workspace and deletes the local copy. */
export async function pollRoutineCodexLogin(deps: RoutineLoginDeps = defaultDeps): Promise<RoutineCodexPoll> {
  const home = pendingHome;
  if (!home) return { state: "idle" };
  let authJson: string;
  try {
    authJson = await readFile(join(home, "auth.json"), "utf8");
  } catch {
    return { state: "waiting" };
  }
  const workspaceId = deps.workspaceId();
  if (!workspaceId) return { state: "failed", error: NOT_SIGNED_IN };
  try {
    await deps.save(workspaceId, authJson);
  } catch (error) {
    await cancelRoutineCodexLogin();
    return { state: "failed", error: error instanceof ServerError && error.code === "invalid_auth_json" ? "Codex did not give a login that routines can use." : "Could not save the Codex login." };
  }
  await discardPending();
  return { state: "connected" };
}

export async function cancelRoutineCodexLogin(): Promise<void> {
  cancelCodexLogin();
  await discardPending();
}
