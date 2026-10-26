import { existsSync, statSync } from "fs";
import { basename, resolve } from "path";
import { hostname } from "os";
import { getCachedWorkspaceId } from "draft-core/auth-state";
import type { LiveSession, LiveSessionEventsPage } from "draft-shared-ui";
import { capture } from "../../exec";
import { ServerError, fetchServer, fetchServerJSON } from "../server/server-client";
import { TranscriptForwarder, type ForwardedLine } from "./forwarder";
import { launchClaudeInTmux, paneIsAlive, tmuxSessionName } from "./launch";
import { getHostMachineId } from "./machine-id";
import { preTrustFolder } from "./pre-trust";

const PANE_WATCH_MS = 2_000;
const FATAL_CODES = new Set(["session_ended", "foreign_host", "not_session_owner", "session_not_found", "live_sessions_disabled"]);

export type StartLiveSessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

interface ActiveSession {
  forwarder: TranscriptForwarder;
  watcher: ReturnType<typeof setInterval>;
}

const active = new Map<string, ActiveSession>();

const ERROR_MESSAGES: Record<string, string> = {
  live_sessions_disabled: "Live sessions are not turned on for this workspace.",
};

async function gitRemote(folderPath: string): Promise<string | null> {
  try {
    const result = await capture(["git", "-C", folderPath, "remote", "get-url", "origin"], { timeoutMs: 3000 });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

async function endSession(workspaceId: string, sessionId: string, hostMachineId: string, reason: string): Promise<void> {
  try {
    await fetchServer(`workspaces/${workspaceId}/live-sessions/${sessionId}/end`, {
      method: "POST",
      body: JSON.stringify({ hostMachineId, reason }),
    });
  } catch (error) {
    console.error("[live-session] end failed", sessionId, error);
  }
}

export async function startLiveSession(
  input: { folderPath: string; model?: string | null },
  findClaude: () => Promise<string | null>,
): Promise<StartLiveSessionResult> {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };

  const folderPath = resolve(input.folderPath);
  if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) return { ok: false, error: "Choose a valid folder." };

  const claudeBin = await findClaude();
  if (!claudeBin) return { ok: false, error: "Claude Code is not installed on this computer." };

  const hostMachineId = getHostMachineId();
  const nativeSessionId = crypto.randomUUID();
  const model = input.model ?? null;

  let sessionId: string;
  try {
    const created = await fetchServerJSON<{ session: { id: string } }>(`workspaces/${workspaceId}/live-sessions`, {
      method: "POST",
      body: JSON.stringify({
        hostMachineId,
        hostName: hostname(),
        folderName: basename(folderPath),
        gitRemote: await gitRemote(folderPath),
        model,
        nativeSessionId,
      }),
    });
    sessionId = created.session.id;
  } catch (error) {
    const code = error instanceof ServerError ? error.code : null;
    return { ok: false, error: (code && ERROR_MESSAGES[code]) ?? "Could not create the session." };
  }

  const tmuxSession = tmuxSessionName(sessionId);
  try {
    preTrustFolder(folderPath);
    await launchClaudeInTmux({ tmuxSession, folderPath, claudeBin, nativeSessionId, model });
  } catch (error) {
    console.error("[live-session] launch failed", error);
    await endSession(workspaceId, sessionId, hostMachineId, "launch_failed");
    return { ok: false, error: "Could not start Claude Code." };
  }

  const stop = () => {
    const entry = active.get(sessionId);
    if (entry) clearInterval(entry.watcher);
    active.delete(sessionId);
  };

  const forwarder = new TranscriptForwarder({
    nativeSessionId,
    post: async (lines: ForwardedLine[]) => {
      await fetchServer(`workspaces/${workspaceId}/live-sessions/${sessionId}/lines`, {
        method: "POST",
        body: JSON.stringify({ hostMachineId, nativeSessionId, lines }),
      });
    },
    isFatal: (error) => error instanceof ServerError && FATAL_CODES.has(error.code),
    onFatal: stop,
  });
  forwarder.start();

  const watcher = setInterval(async () => {
    if (await paneIsAlive(tmuxSession)) return;
    stop();
    await forwarder.stop();
    await endSession(workspaceId, sessionId, hostMachineId, "exited");
  }, PANE_WATCH_MS);

  active.set(sessionId, { forwarder, watcher });
  return { ok: true, sessionId };
}

export async function listLiveSessions(): Promise<{ enabled: boolean; sessions: LiveSession[] }> {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) return { enabled: false, sessions: [] };
  try {
    const body = await fetchServerJSON<{ sessions: LiveSession[] }>(`workspaces/${workspaceId}/live-sessions`);
    return { enabled: true, sessions: body.sessions };
  } catch (error) {
    if (error instanceof ServerError && error.code === "live_sessions_disabled") return { enabled: false, sessions: [] };
    throw error;
  }
}

export async function getLiveSessionEvents(sessionId: string, after: number): Promise<LiveSessionEventsPage> {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) throw new ServerError("signed_out");
  return fetchServerJSON<LiveSessionEventsPage>(`workspaces/${workspaceId}/live-sessions/${sessionId}/events?after=${after}`);
}
