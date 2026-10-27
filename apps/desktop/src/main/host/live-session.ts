import { existsSync, statSync } from "fs";
import { basename, resolve } from "path";
import { hostname } from "os";
import { getCachedWorkspaceId } from "draft-core/auth-state";
import type { LiveSession, LiveSessionEventsPage, LiveSessionInput } from "draft-shared-ui";
import { capture } from "../../exec";
import { ServerError, fetchServer, fetchServerJSON } from "../server/server-client";
import { deleteState, loadStates, saveState, type HostSessionState } from "./cursor-store";
import { TranscriptForwarder, type ForwardedLine } from "./forwarder";
import { InputDelivery, type PendingInput } from "./input-delivery";
import { capturePane, launchClaudeInTmux, paneIsAlive, pasteIntoPane, pressEnter, restorePaneSize, tmuxSessionName } from "./launch";
import { getHostMachineId } from "./machine-id";
import { preTrustFolder } from "./pre-trust";
import { openPaneInTerminal } from "./open-in-terminal";
import { putSigned, uploadRawFiles } from "./raw-upload";

const PANE_WATCH_MS = 2_000;
const CATCH_UP_RETRY_MS = 2_000;
const FATAL_CODES = new Set(["session_ended", "foreign_host", "not_session_owner", "session_not_found", "live_sessions_disabled"]);

export type StartLiveSessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

const running = new Map<string, SessionRunner>();

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

/** Forwards one session's transcript while its pane lives, then finishes it: last lines, raw upload, end. */
class SessionRunner {
  private readonly forwarder: TranscriptForwarder;
  private readonly delivery: InputDelivery;
  private caughtUp = false;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private stepping = false;
  private finished = false;
  private readonly base: string;

  constructor(private state: HostSessionState) {
    this.base = `workspaces/${state.workspaceId}/live-sessions/${state.sessionId}`;
    this.forwarder = new TranscriptForwarder({
      nativeSessionId: state.nativeSessionId,
      cursors: state.cursors,
      onCursors: (cursors) => this.persist({ cursors }),
      post: async (lines: ForwardedLine[]) => {
        await fetchServer(`${this.base}/lines`, {
          method: "POST",
          body: JSON.stringify({ hostMachineId: state.hostMachineId, nativeSessionId: state.nativeSessionId, lines }),
        });
      },
      isFatal: (error) => error instanceof ServerError && FATAL_CODES.has(error.code),
      onFatal: () => this.abandon(),
    });
    this.delivery = new InputDelivery({
      fetchPending: async () =>
        (await fetchServerJSON<{ inputs: PendingInput[] }>(`${this.base}/inputs/pending?hostMachineId=${encodeURIComponent(state.hostMachineId)}`)).inputs,
      setState: async (id, from, to, reason) =>
        (await fetchServerJSON<{ changed: boolean }>(`${this.base}/inputs/${id}/state`, {
          method: "POST",
          body: JSON.stringify({ hostMachineId: state.hostMachineId, from, to, reason }),
        })).changed,
      capture: () => capturePane(state.tmuxSession),
      paste: (text) => pasteIntoPane(state.tmuxSession, text),
      pressEnter: () => pressEnter(state.tmuxSession),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    });
  }

  start(): void {
    if (!this.state.ended) {
      this.forwarder.start();
      void this.catchUp();
    }
    this.watcher = setInterval(() => void this.step(), PANE_WATCH_MS);
    running.set(this.state.sessionId, this);
  }

  /** Input delivery waits until the transcript is up to date, so a sent message is not called uncertain too soon. */
  private async catchUp(): Promise<void> {
    while (!this.finished && !(await this.forwarder.tick())) {
      await new Promise((done) => setTimeout(done, CATCH_UP_RETRY_MS));
    }
    this.caughtUp = true;
  }

  private persist(patch: Partial<HostSessionState>): void {
    this.state = { ...this.state, ...patch };
    saveState(this.state);
  }

  private abandon(): void {
    this.finished = true;
    this.forwarder.halt();
    if (this.watcher) clearInterval(this.watcher);
    running.delete(this.state.sessionId);
    deleteState(this.state.sessionId);
  }

  private async rawUpload(): Promise<boolean> {
    try {
      const rawUploads = await uploadRawFiles(this.forwarder.files(), this.state.rawUploads, {
        requestUrls: async (files) =>
          (await fetchServerJSON<{ uploads: Array<{ file: string; signedUrl: string }> }>(`${this.base}/raw`, {
            method: "POST",
            body: JSON.stringify({ hostMachineId: this.state.hostMachineId, files }),
          })).uploads,
        put: putSigned,
        complete: async () => {
          await fetchServer(`${this.base}/raw/complete`, {
            method: "POST",
            body: JSON.stringify({ hostMachineId: this.state.hostMachineId }),
          });
        },
      });
      if (rawUploads !== this.state.rawUploads) this.persist({ rawUploads });
      return true;
    } catch (error) {
      console.error("[live-session] raw upload failed", this.state.sessionId, error);
      return false;
    }
  }

  private async endOnServer(): Promise<boolean> {
    try {
      await fetchServer(`${this.base}/end`, {
        method: "POST",
        body: JSON.stringify({ hostMachineId: this.state.hostMachineId, reason: "exited" }),
      });
      return true;
    } catch (error) {
      // An already ended session is the outcome we wanted.
      if (error instanceof ServerError && error.code === "session_ended") return true;
      console.error("[live-session] end failed", this.state.sessionId, error);
      return false;
    }
  }

  private async whileAlive(): Promise<void> {
    await restorePaneSize(this.state.tmuxSession).catch(() => {});
    if (!this.caughtUp) return;
    try {
      await this.delivery.tick();
    } catch (error) {
      if (!(error instanceof ServerError && FATAL_CODES.has(error.code))) console.error("[live-session] input delivery failed", error);
    }
  }

  /** One pass; runs every few seconds and does the next unfinished piece of work. */
  async step(): Promise<void> {
    if (this.stepping || this.finished) return;
    this.stepping = true;
    try {
      if (!this.state.ended) {
        if (await paneIsAlive(this.state.tmuxSession)) {
          await this.whileAlive();
          return;
        }
        this.forwarder.halt();
        if (!(await this.forwarder.tick())) return;
        if (!(await this.endOnServer())) return;
        this.persist({ ended: true });
      }
      if (await this.rawUpload()) this.abandon();
      // TODO: also upload on the Stop hook once the hooks server exists.
    } finally {
      this.stepping = false;
    }
  }

  hasEnded(): boolean {
    return this.state.ended || this.finished;
  }

  tmuxSession(): string {
    return this.state.tmuxSession;
  }

  /** Uploads raw files newer than the last upload, for a pane that is still running. */
  async uploadIfChanged(): Promise<void> {
    await this.forwarder.tick();
    await this.rawUpload();
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

  const state: HostSessionState = {
    sessionId,
    workspaceId,
    hostMachineId,
    nativeSessionId,
    folderPath,
    tmuxSession: tmuxSessionName(sessionId),
    cursors: {},
    rawUploads: {},
    ended: false,
  };

  try {
    preTrustFolder(folderPath);
    await launchClaudeInTmux({ tmuxSession: state.tmuxSession, folderPath, claudeBin, nativeSessionId, model });
  } catch (error) {
    console.error("[live-session] launch failed", error);
    await fetchServer(`workspaces/${workspaceId}/live-sessions/${sessionId}/end`, {
      method: "POST",
      body: JSON.stringify({ hostMachineId, reason: "launch_failed" }),
    }).catch(() => {});
    return { ok: false, error: "Could not start Claude Code." };
  }

  saveState(state);
  new SessionRunner(state).start();
  return { ok: true, sessionId };
}

/** Picks up the sessions this machine was forwarding when the app last closed. */
export async function resumeLiveSessions(): Promise<void> {
  for (const state of loadStates()) {
    if (running.has(state.sessionId)) continue;
    const runner = new SessionRunner(state);
    runner.start();
    if (!state.ended && (await paneIsAlive(state.tmuxSession))) await runner.uploadIfChanged();
  }
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

function sessionBase(sessionId: string): string {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) throw new ServerError("signed_out");
  return `workspaces/${workspaceId}/live-sessions/${sessionId}`;
}

export async function getLiveSessionEvents(sessionId: string, after: number): Promise<LiveSessionEventsPage> {
  return fetchServerJSON<LiveSessionEventsPage>(`${sessionBase(sessionId)}/events?after=${after}`);
}

export async function sendLiveSessionMessage(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fetchServer(`${sessionBase(sessionId)}/inputs`, { method: "POST", body: JSON.stringify({ text }) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "send_failed" };
  }
}

export async function listLiveSessionInputs(sessionId: string): Promise<LiveSessionInput[]> {
  return (await fetchServerJSON<{ inputs: LiveSessionInput[] }>(`${sessionBase(sessionId)}/inputs`)).inputs;
}

export async function actOnLiveSessionInput(sessionId: string, inputId: string, action: "resend" | "dismiss"): Promise<void> {
  await fetchServer(`${sessionBase(sessionId)}/inputs/${inputId}`, { method: "POST", body: JSON.stringify({ action }) });
}

/** Ids of the live sessions whose pane runs on this computer. */
export function hostedLiveSessionIds(): string[] {
  return [...running.keys()].filter((id) => !running.get(id)!.hasEnded());
}

/** Opens the owner's terminal app on the session's pane. */
export async function openLiveSessionInTerminal(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const runner = running.get(sessionId);
  if (!runner || runner.hasEnded()) return { ok: false, error: "This session does not run on this computer." };
  return openPaneInTerminal(runner.tmuxSession());
}
