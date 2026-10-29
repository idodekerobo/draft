import { existsSync, statSync } from "fs";
import { basename, resolve } from "path";
import { hostname } from "os";
import { getCachedWorkspaceId } from "draft-core/auth-state";
import { DEFAULT_HARNESS_ID, isHarnessId, isKnownModel } from "draft-core/harnesses";
import { hostErrorAction } from "draft-core/live-sessions";
import type { LiveSession, LiveSessionEventsPage } from "draft-shared-ui";
import { ServerError, fetchServer, fetchServerJSON } from "../server/server-client";
import type { HostEvent } from "./approvals";
import { deleteState, loadStates, saveState, type HostSessionState } from "./cursor-store";
import { registrationFor } from "./drivers";
import { getHostMachineId } from "./machine-id";
import { gitRemote } from "./git-remote";
import { startHeartbeat } from "./heartbeat";
import { LaunchError, type HarnessDriver, type HostInput } from "./harness-driver";

const PANE_WATCH_MS = 2_000;

export type StartLiveSessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

const running = new Map<string, SessionRunner>();

/** Keeps one session alive on this computer: heartbeat, inputs, posting. The driver does what is specific to the harness. */
class SessionRunner {
  private readonly driver: HarnessDriver;
  private stopHeartbeat: (() => void) | null = null;
  private successor: HostSessionState | null = null;
  private endReason = "exited";
  private uploading = false;
  private uploadWanted = false;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private stepping = false;
  private finished = false;
  private readonly base: string;

  constructor(private state: HostSessionState) {
    this.base = `workspaces/${state.workspaceId}/live-sessions/${state.sessionId}`;
    this.driver = registrationFor(state.harness).createDriver({
      base: this.base,
      state: () => this.state,
      persist: (patch) => this.persist(patch),
      postLines: async (lines) => {
        await fetchServer(`${this.base}/lines`, {
          method: "POST",
          body: JSON.stringify({ hostMachineId: this.state.hostMachineId, nativeSessionId: this.state.nativeSessionId, lines }),
        });
      },
      postHostEvents: (events) => this.postHostEvents(events),
      setInputState: this.setInputState,
      isFatal: (error) => error instanceof ServerError && hostErrorAction(error.code) !== "retry",
      onFatal: (error) => (error instanceof ServerError && hostErrorAction(error.code) === "pause" ? this.suspend() : this.abandon()),
      reportError: (what, error) => this.reportInputError(what, error),
      requestUpload: () => {
        this.uploadWanted = true;
      },
    });
  }

  /** Teammate messages, Stops and permission decisions that wait for this host, in one call. */
  private async fetchInputs(): Promise<HostInput[]> {
    const query = `hostMachineId=${encodeURIComponent(this.state.hostMachineId)}&kinds=all`;
    return (await fetchServerJSON<{ inputs: HostInput[] }>(`${this.base}/inputs/pending?${query}`)).inputs;
  }

  /** Returns false when the input was no longer in one of the `from` states. */
  private readonly setInputState = async (id: string, from: Array<"queued" | "delivering">, to: string, reason?: string): Promise<boolean> =>
    (await fetchServerJSON<{ changed: boolean }>(`${this.base}/inputs/${id}/state`, {
      method: "POST",
      body: JSON.stringify({ hostMachineId: this.state.hostMachineId, from, to, reason }),
    })).changed;

  private async postHostEvents(events: HostEvent[]): Promise<void> {
    await fetchServer(`${this.base}/host-events`, {
      method: "POST",
      body: JSON.stringify({ hostMachineId: this.state.hostMachineId, events }),
    });
  }

  start(): void {
    if (!this.state.ended) {
      this.stopHeartbeat = startHeartbeat(() => this.sendHeartbeat());
      this.driver.start();
    }
    this.watcher = setInterval(() => void this.step(), PANE_WATCH_MS);
    running.set(this.state.sessionId, this);
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await fetchServer(`${this.base}/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ hostMachineId: this.state.hostMachineId, harnessVersion: this.state.harnessVersion ?? null }),
      });
    } catch (error) {
      this.reportInputError("heartbeat", error);
    }
  }

  private persist(patch: Partial<HostSessionState>): void {
    this.state = { ...this.state, ...patch };
    saveState(this.state);
  }

  /** This login cannot reach the session (another environment or account). Stop work and keep the saved state. */
  private suspend(): void {
    if (this.finished) return;
    console.warn("[live-session] paused: this login cannot reach session", this.state.sessionId);
    this.finished = true;
    this.stopHeartbeat?.();
    this.driver.dispose();
    if (this.watcher) clearInterval(this.watcher);
    running.delete(this.state.sessionId);
  }

  private abandon(): void {
    this.finished = true;
    this.stopHeartbeat?.();
    this.driver.dispose();
    if (this.watcher) clearInterval(this.watcher);
    running.delete(this.state.sessionId);
    deleteState(this.state.sessionId);
  }

  private async endOnServer(): Promise<boolean> {
    try {
      await fetchServer(`${this.base}/end`, {
        method: "POST",
        body: JSON.stringify({ hostMachineId: this.state.hostMachineId, reason: this.endReason }),
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
    let pending: HostInput[];
    try {
      pending = await this.fetchInputs();
    } catch (error) {
      this.reportInputError("fetching inputs", error);
      return;
    }
    await this.driver.serve(pending);
  }

  private reportInputError(what: string, error: unknown): void {
    const action = error instanceof ServerError ? hostErrorAction(error.code) : "retry";
    if (action === "pause") this.suspend();
    else if (action === "retry") console.error(`[live-session] ${what} failed`, error);
  }

  /** One pass; runs every few seconds and does the next unfinished piece of work. */
  async step(): Promise<void> {
    if (this.stepping || this.finished) return;
    this.stepping = true;
    try {
      if (!this.state.ended) {
        const rotateTo = this.driver.rotationTarget();
        if (rotateTo && (await this.rotate(rotateTo))) return;
        if (await this.driver.isAlive()) {
          await this.whileAlive();
          return;
        }
        if (!(await this.driver.flush())) return;
        if (!(await this.endOnServer())) return;
        this.stopHeartbeat?.();
        this.persist({ ended: true });
      }
      if (await this.driver.finalize()) this.abandon();
    } finally {
      this.stepping = false;
      // A Stop hook that came in during a step is served now.
      if (this.uploadWanted && !this.finished) {
        this.uploadWanted = false;
        void this.uploadIfChanged();
      }
    }
  }

  /**
   * After `/clear` or `/fork` the pane holds a new conversation. This ends the session and starts a linked one on the
   * same pane. Returns true while the old session still has to finish, and false when there is nothing more to do here.
   */
  private async rotate(nativeSessionId: string): Promise<boolean> {
    if (!(await this.driver.flush())) return true;
    try {
      this.successor ??= await this.createSuccessor(nativeSessionId);
    } catch (error) {
      this.reportInputError("starting the linked session", error);
      return true;
    }
    this.endReason = "cleared";
    if (!(await this.endOnServer())) return true;
    this.stopHeartbeat?.();
    this.persist({ ended: true });
    saveState(this.successor);
    new SessionRunner(this.successor).start();
    this.driver.clearRotation();
    return true;
  }

  private async createSuccessor(nativeSessionId: string): Promise<HostSessionState> {
    const { folderPath, hostMachineId, workspaceId, model = null, harnessVersion = null } = this.state;
    const harness = this.state.harness ?? DEFAULT_HARNESS_ID;
    const created = await fetchServerJSON<{ session: { id: string } }>(`workspaces/${workspaceId}/live-sessions`, {
      method: "POST",
      body: JSON.stringify({
        hostMachineId,
        hostName: hostname(),
        folderName: basename(folderPath),
        gitRemote: await gitRemote(folderPath),
        harness,
        model,
        nativeSessionId,
        harnessVersion,
        previousSessionId: this.state.sessionId,
      }),
    });
    return {
      sessionId: created.session.id,
      workspaceId,
      hostMachineId,
      nativeSessionId,
      folderPath,
      harness,
      tmuxSession: this.state.tmuxSession,
      cursors: {},
      rawUploads: {},
      ended: false,
      hookId: this.state.hookId ?? this.state.sessionId,
      model,
      harnessVersion,
    };
  }

  hasEnded(): boolean {
    return this.state.ended || this.finished;
  }

  /** Uploads raw files newer than the last upload, for a pane that is still running. */
  async uploadIfChanged(): Promise<void> {
    if (this.uploading || this.stepping || this.finished) return;
    this.uploading = true;
    try {
      await this.driver.refresh();
      await this.driver.finalize();
    } finally {
      this.uploading = false;
    }
  }

  async endByOwner(): Promise<void> {
    this.endReason = "ended_by_owner";
    await this.driver.stop();
  }

  openInTerminal(): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.driver.openInTerminal();
  }

  isAlive(): Promise<boolean> {
    return this.driver.isAlive();
  }
}

export async function startLiveSession(input: { harness?: string; folderPath: string; model?: string | null }): Promise<StartLiveSessionResult> {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };

  const harness = input.harness ?? DEFAULT_HARNESS_ID;
  if (!isHarnessId(harness)) return { ok: false, error: "Choose an agent from the list." };
  const { launcher } = registrationFor(harness);

  const folderPath = resolve(input.folderPath);
  if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) return { ok: false, error: "Choose a valid folder." };

  const checked = await launcher.check();
  if (!checked.ok) return { ok: false, error: checked.error };
  if (!isKnownModel(harness, input.model)) return { ok: false, error: "Choose a model from the list." };

  const hostMachineId = getHostMachineId();
  const nativeSessionId = launcher.newNativeSessionId();
  const model = input.model ?? null;
  const harnessVersion = checked.version;

  let sessionId: string;
  try {
    const created = await fetchServerJSON<{ session: { id: string } }>(`workspaces/${workspaceId}/live-sessions`, {
      method: "POST",
      body: JSON.stringify({
        hostMachineId,
        hostName: hostname(),
        folderName: basename(folderPath),
        gitRemote: await gitRemote(folderPath),
        harness,
        model,
        nativeSessionId,
        harnessVersion,
      }),
    });
    sessionId = created.session.id;
  } catch {
    return { ok: false, error: "Could not create the session." };
  }

  let state: HostSessionState = {
    sessionId,
    workspaceId,
    hostMachineId,
    nativeSessionId,
    folderPath,
    harness,
    cursors: {},
    rawUploads: {},
    ended: false,
    model,
    harnessVersion,
  };

  try {
    state = { ...state, ...(await launcher.launch({ sessionId, folderPath, model, bin: checked.bin, nativeSessionId })) };
  } catch (error) {
    console.error("[live-session] launch failed", error);
    await fetchServer(`workspaces/${workspaceId}/live-sessions/${sessionId}/end`, {
      method: "POST",
      body: JSON.stringify({ hostMachineId, reason: "launch_failed" }),
    }).catch(() => {});
    return { ok: false, error: error instanceof LaunchError ? error.message : launcher.launchFailedMessage };
  }

  saveState(state);
  new SessionRunner(state).start();
  return { ok: true, sessionId };
}

/** Starts an ended session of the owner again on this computer. It is the same session, live again. */
export async function resumeLiveSession(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
  if (running.get(sessionId) && !running.get(sessionId)!.hasEnded()) return { ok: false, error: "This session is already running." };

  let session: LiveSession & { native_session_id?: string | null; host_machine_id?: string; end_reason?: string | null };
  try {
    session = (await fetchServerJSON<LiveSessionEventsPage>(`${sessionBase(sessionId)}/events?after=0&limit=1`)).session as typeof session;
  } catch {
    return { ok: false, error: "Could not load the session." };
  }
  const hostMachineId = getHostMachineId();
  if (!session.mine) return { ok: false, error: "Only the person who started a session can resume it." };
  if (session.status !== "ended") return { ok: false, error: "This session is not ended." };
  if (session.end_reason === "cleared") return { ok: false, error: "This conversation was cleared. Open the session that continued it." };
  if (session.host_machine_id !== hostMachineId || !session.native_session_id) return { ok: false, error: "This session ran on another computer. Resume it there." };

  const harness = session.harness ?? DEFAULT_HARNESS_ID;
  if (!isHarnessId(harness)) return { ok: false, error: "This session's agent is not supported by this version of Draft." };
  const { launcher } = registrationFor(harness);
  const checked = await launcher.check();
  if (!checked.ok) return { ok: false, error: checked.error };

  try {
    await fetchServer(`${sessionBase(sessionId)}/reopen`, { method: "POST", body: JSON.stringify({ hostMachineId }) });
  } catch (error) {
    return { ok: false, error: error instanceof ServerError && error.code === "session_cleared" ? "This conversation was cleared." : "Could not reopen the session." };
  }

  let state: HostSessionState = {
    sessionId,
    workspaceId,
    hostMachineId,
    nativeSessionId: session.native_session_id,
    folderPath: "",
    harness,
    cursors: {},
    rawUploads: {},
    ended: false,
    model: session.model ?? null,
    harnessVersion: checked.version,
  };
  try {
    state = { ...state, ...(await launcher.resume({ sessionId, nativeSessionId: session.native_session_id, model: state.model ?? null, bin: checked.bin })) };
  } catch (error) {
    console.error("[live-session] resume failed", error);
    await fetchServer(`${sessionBase(sessionId)}/end`, { method: "POST", body: JSON.stringify({ hostMachineId, reason: "resume_failed" }) }).catch(() => {});
    return { ok: false, error: error instanceof LaunchError ? error.message : "Could not resume the session." };
  }

  saveState(state);
  new SessionRunner(state).start();
  return { ok: true };
}

/** Picks up the sessions this machine was forwarding when the app last closed. */
export async function resumeLiveSessions(): Promise<void> {
  for (const state of loadStates()) {
    if (running.has(state.sessionId)) continue;
    const runner = new SessionRunner(state);
    runner.start();
    if (!state.ended && (await runner.isAlive())) await runner.uploadIfChanged();
  }
}

export async function listLiveSessions(): Promise<LiveSession[]> {
  const workspaceId = getCachedWorkspaceId();
  if (!workspaceId) return [];
  const body = await fetchServerJSON<{ sessions: LiveSession[] }>(`workspaces/${workspaceId}/live-sessions`);
  return body.sessions;
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

export async function actOnLiveSessionInput(sessionId: string, inputId: string, action: "resend" | "dismiss" | "steer"): Promise<void> {
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
  return runner.openInTerminal();
}

/** Sends a teammate's decision on an open permission request. */
export async function decideLiveSessionApproval(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
): Promise<{ ok: true } | { ok: false; error: string; byName?: string | null; reason?: string | null }> {
  try {
    await fetchServer(`${sessionBase(sessionId)}/approvals/${encodeURIComponent(requestId)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ServerError)) return { ok: false, error: "decision_failed" };
    const detail = (error.detail ?? {}) as { by_name?: string | null; reason?: string | null };
    return { ok: false, error: error.code, byName: detail.by_name ?? null, reason: detail.reason ?? null };
  }
}

export async function stopLiveSession(sessionId: string): Promise<{ ok: true; withdrawn: string[] } | { ok: false; error: string }> {
  try {
    const response = await fetchServer(`${sessionBase(sessionId)}/stop`, { method: "POST", body: "{}" });
    const body = (await response.json().catch(() => ({}))) as { withdrawn?: Array<{ text: string }> };
    return { ok: true, withdrawn: (body.withdrawn ?? []).map((input) => input.text) };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "stop_failed" };
  }
}

/** Ends a session that runs on this computer. */
export async function endLiveSession(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const runner = running.get(sessionId);
  if (!runner || runner.hasEnded()) return { ok: false, error: "This session does not run on this computer." };
  try {
    await runner.endByOwner();
    return { ok: true };
  } catch (error) {
    console.error("[live-session] end failed", sessionId, error);
    return { ok: false, error: "Could not end the session." };
  }
}
