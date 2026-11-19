import { existsSync, statSync } from "fs";
import { basename, resolve } from "path";
import { hostname } from "os";
import { DEFAULT_HARNESS_ID, isEffortFor, isHarnessId, isKnownModel } from "../harnesses";
import { SIGNAL_EVENTS, type LiveSession, type LiveSessionEventsPage } from "../live-sessions";
import { hostServices, ServerError } from "./services";
import type { HostEvent } from "./approvals";
import { deleteState, loadStates, saveState, type HostSessionState } from "./cursor-store";
import { registrationFor } from "./drivers/drivers";
import { gitRemote } from "./git-remote";
import { hostFailureAction } from "./host-failure";
import { startHeartbeat } from "./heartbeat";
import { InputWake } from "./input-wake";
import { SessionTopics } from "./session-topics";
import { LaunchError, type HarnessDriver, type HostInput } from "./drivers/harness-driver";

const PANE_WATCH_MS = 2_000;

export type StartLiveSessionResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** A session this machine runs for a server row that already exists (a cloud session). */
export interface AttachedSession {
  hasEnded(): boolean;
  activity(): Promise<SessionActivity>;
  /** Stops the passes, then forwards what is left. True when all of it reached the server. */
  retire(): Promise<boolean>;
}

/** What a host reads to decide whether its session can sleep. */
export interface SessionActivity {
  turnRunning: boolean;
  /** Ms since epoch of the last pass that found an input from the server. */
  lastInputAt: number;
  /** Ms since epoch each permission request still open was asked. */
  openApprovalsSince: number[];
  /** Inputs the last answer from the server held, queued or being delivered. */
  pendingInputs: number;
  /** Ms since epoch of the last answer from the server, or 0 when none came yet. */
  inputsCheckedAt: number;
}

const running = new Map<string, SessionHost>();

/** Keeps one session alive on this computer: heartbeat, inputs, posting. The driver does what is specific to the harness. */
class SessionHost {
  private readonly driver: HarnessDriver;
  private stopHeartbeat: (() => void) | null = null;
  private successor: HostSessionState | null = null;
  private endReason = "exited";
  private uploading = false;
  private uploadWanted = false;
  private watcher: ReturnType<typeof setTimeout> | null = null;
  private stepping = false;
  private wakePending = false;
  private readonly topics: SessionTopics;
  private readonly inputWake = new InputWake(undefined, undefined, () => hostServices().realtime.connected());
  /** The last list from the server. Passes between fetches reuse it; each delivery still claims its input first. */
  private pending: HostInput[] = [];
  private finished = false;
  private lastInputAt = Date.now();
  private inputsCheckedAt = 0;
  private readonly openSince = new Map<string, number>();
  private readonly base: string;

  constructor(private state: HostSessionState) {
    this.base = `workspaces/${state.workspaceId}/live-sessions/${state.sessionId}`;
    this.topics = new SessionTopics((topic, listener) => hostServices().realtime.watch(topic, listener), state.sessionId, (event) => {
      if (event === SIGNAL_EVENTS.inputs || event === SIGNAL_EVENTS.catchUp) this.wake();
    });
    this.driver = registrationFor(state.harness).createDriver({
      base: this.base,
      state: () => this.state,
      persist: (patch) => this.persist(patch),
      postLines: async (lines) => {
        await hostServices().fetchServer(`${this.base}/lines`, {
          method: "POST",
          body: JSON.stringify({ hostId: this.state.hostId, nativeSessionId: this.state.nativeSessionId, lines }),
        });
      },
      postHostEvents: (events) => this.postHostEvents(events),
      setInputState: this.setInputState,
      isFatal: (error) => hostFailureAction(error) !== "retry",
      onFatal: (error) => (hostFailureAction(error) === "pause" ? this.suspend() : this.abandon()),
      reportError: (what, error) => this.reportInputError(what, error),
      requestUpload: () => {
        this.uploadWanted = true;
      },
      wake: () => this.wake(),
      reportModes: (modes) => this.reportModes(modes),
      reportAgent: (agent) => this.reportAgent(agent),
    });
  }

  /** Teammate messages, Stops and permission decisions that wait for this host, in one call. */
  private async fetchInputs(): Promise<HostInput[]> {
    const query = `hostId=${encodeURIComponent(this.state.hostId)}&kinds=all`;
    return (await hostServices().fetchServerJSON<{ inputs: HostInput[] }>(`${this.base}/inputs/pending?${query}`)).inputs;
  }

  /** Returns false when the input was no longer in one of the `from` states. */
  private readonly setInputState = async (id: string, from: Array<"queued" | "delivering">, to: string, reason?: string): Promise<boolean> =>
    (await hostServices().fetchServerJSON<{ changed: boolean }>(`${this.base}/inputs/${id}/state`, {
      method: "POST",
      body: JSON.stringify({ hostId: this.state.hostId, from, to, reason }),
    })).changed;

  private async postHostEvents(events: HostEvent[]): Promise<void> {
    await hostServices().fetchServer(`${this.base}/host-events`, {
      method: "POST",
      body: JSON.stringify({ hostId: this.state.hostId, events }),
    });
  }

  start(): void {
    if (!this.state.ended) {
      this.stopHeartbeat = startHeartbeat(() => this.sendHeartbeat());
      this.driver.start();
    }
    this.scheduleStep();
    running.set(this.state.sessionId, this);
  }

  /** The next pass comes after the time the driver asks for, so an active session is picked up faster. */
  private scheduleStep(): void {
    if (this.finished) return;
    const delay = this.wakePending ? 0 : (this.driver.pollMs?.() ?? PANE_WATCH_MS);
    this.wakePending = false;
    this.watcher = setTimeout(() => {
      void this.step().finally(() => this.scheduleStep());
    }, delay);
  }

  /** The server signalled new inputs: run the next pass now, or right after the one that is running. */
  private wake(): void {
    if (this.finished) return;
    this.inputWake.signal();
    if (this.stepping) {
      this.wakePending = true;
      return;
    }
    if (this.watcher) clearTimeout(this.watcher);
    this.wakePending = true;
    this.scheduleStep();
  }

  private stopWatching(): void {
    this.topics.close();
  }

  private modes: { permissionMode?: string | null; approvalMode?: string | null } = {};

  private reportModes(modes: { permissionMode?: string | null; approvalMode?: string | null }): void {
    const changed = (Object.keys(modes) as Array<keyof typeof modes>).some((key) => modes[key] != null && modes[key] !== this.modes[key]);
    this.modes = { ...this.modes, ...Object.fromEntries(Object.entries(modes).filter(([, value]) => value != null)) };
    if (changed) void this.sendHeartbeat();
  }

  private agent: { model?: string | null; reasoningEffort?: string | null } = {};

  private reportAgent(agent: { model: string | null; reasoningEffort: string | null }): void {
    const changed = agent.model !== this.agent.model || agent.reasoningEffort !== this.agent.reasoningEffort;
    this.agent = agent;
    this.persist({ model: agent.model, reasoningEffort: agent.reasoningEffort });
    if (changed) void this.sendHeartbeat();
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      await hostServices().fetchServer(`${this.base}/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ hostId: this.state.hostId, harnessVersion: this.state.harnessVersion ?? null, ...this.modes, ...this.agent }),
      });
      this.topics.open();
    } catch (error) {
      this.reportInputError("heartbeat", error);
    }
  }

  private persist(patch: Partial<HostSessionState>): void {
    this.state = { ...this.state, ...patch };
    saveState(this.state);
    if (patch.openRequests) this.trackOpenRequests(patch.openRequests);
  }

  /** Remembers when each open request was asked, so a host can tell a fresh one from a stale one. */
  private trackOpenRequests(open: string[]): void {
    for (const id of open) if (!this.openSince.has(id)) this.openSince.set(id, Date.now());
    for (const id of [...this.openSince.keys()]) if (!open.includes(id)) this.openSince.delete(id);
  }

  /** There is no login, or this one cannot reach the session (another environment or account). Stop work and keep the saved state. */
  private suspend(): void {
    if (this.finished) return;
    console.warn("[live-session] paused: no login can reach session", this.state.sessionId);
    this.finished = true;
    this.stopWatching();
    this.stopHeartbeat?.();
    this.driver.dispose();
    if (this.watcher) clearTimeout(this.watcher);
    running.delete(this.state.sessionId);
  }

  private abandon(): void {
    this.finished = true;
    this.stopWatching();
    this.stopHeartbeat?.();
    this.driver.dispose();
    if (this.watcher) clearTimeout(this.watcher);
    running.delete(this.state.sessionId);
    deleteState(this.state.sessionId);
  }

  private async endOnServer(): Promise<boolean> {
    try {
      await hostServices().fetchServer(`${this.base}/end`, {
        method: "POST",
        body: JSON.stringify({ hostId: this.state.hostId, reason: this.endReason }),
      });
      return true;
    } catch (error) {
      // An already ended or deleted session is the outcome we wanted.
      if (error instanceof ServerError && (error.code === "session_ended" || error.code === "session_not_found")) return true;
      console.error("[live-session] end failed", this.state.sessionId, error);
      return false;
    }
  }

  private async whileAlive(): Promise<void> {
    if (this.inputWake.due()) {
      this.inputWake.asking();
      try {
        this.pending = await this.fetchInputs();
      } catch (error) {
        this.inputWake.failed();
        this.reportInputError("fetching inputs", error);
        return;
      }
      this.topics.open();
      this.inputWake.answered(this.pending.length);
      this.inputsCheckedAt = Date.now();
      if (this.pending.length > 0) this.lastInputAt = Date.now();
    }
    await this.driver.serve(this.pending);
  }

  private reportInputError(what: string, error: unknown): void {
    const action = hostFailureAction(error);
    if (action === "pause") this.suspend();
    // Only a session that is gone stops the host. Other stop codes can come from a mismatched login or host.
    else if (action === "stop" && error instanceof ServerError && (error.code === "session_ended" || error.code === "session_not_found")) this.abandon();
    else if (action === "retry") console.error(`[live-session] ${what} failed`, error);
  }

  /** One pass; runs every few seconds and does the next unfinished piece of work. */
  async step(): Promise<void> {
    if (this.stepping || this.finished) return;
    this.stepping = true;
    try {
      if (!this.state.ended) {
        const rotateTo = this.driver.rotationTarget?.() ?? null;
        if (rotateTo && (await this.rotate(rotateTo))) return;
        if (await this.driver.isAlive()) {
          await this.whileAlive();
          return;
        }
        if (!(await this.driver.flush())) return;
        if (!(await this.endOnServer())) return;
        this.stopHeartbeat?.();
        this.stopWatching();
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
    this.stopWatching();
    this.persist({ ended: true });
    saveState(this.successor);
    new SessionHost(this.successor).start();
    this.driver.clearRotation?.();
    return true;
  }

  private async createSuccessor(nativeSessionId: string): Promise<HostSessionState> {
    const { folderPath, hostId, workspaceId, model = null, reasoningEffort = null, harnessVersion = null } = this.state;
    const harness = this.state.harness ?? DEFAULT_HARNESS_ID;
    const created = await hostServices().fetchServerJSON<{ session: { id: string } }>(`workspaces/${workspaceId}/live-sessions`, {
      method: "POST",
      body: JSON.stringify({
        hostId,
        hostName: hostname(),
        folderName: basename(folderPath),
        gitRemote: await gitRemote(folderPath),
        harness,
        model,
        reasoningEffort,
        nativeSessionId,
        harnessVersion,
        previousSessionId: this.state.sessionId,
      }),
    });
    return {
      sessionId: created.session.id,
      workspaceId,
      hostId,
      nativeSessionId,
      folderPath,
      harness,
      tmuxSession: this.state.tmuxSession,
      cursors: {},
      rawUploads: {},
      ended: false,
      hookId: this.state.hookId ?? this.state.sessionId,
      model,
      reasoningEffort,
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

  async openInTerminal(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.driver.openInTerminal) return { ok: false, error: "This agent cannot open in a terminal." };
    return this.driver.openInTerminal();
  }

  folderPath(): string {
    return this.state.folderPath;
  }

  isAlive(): Promise<boolean> {
    return this.driver.isAlive();
  }

  async activity(): Promise<SessionActivity> {
    return {
      turnRunning: (await this.driver.turnRunning?.()) ?? false,
      lastInputAt: this.lastInputAt,
      openApprovalsSince: [...this.openSince.values()],
      pendingInputs: this.pending.length,
      inputsCheckedAt: this.inputsCheckedAt,
    };
  }

  async retire(): Promise<boolean> {
    this.finished = true;
    if (this.watcher) clearTimeout(this.watcher);
    while (this.stepping || this.uploading) await new Promise((done) => setTimeout(done, 100));
    const flushed = (await this.driver.flush()) && (await this.driver.finalize());
    this.stopHeartbeat?.();
    this.stopWatching();
    this.driver.dispose();
    running.delete(this.state.sessionId);
    return flushed;
  }
}

export async function startLiveSession(input: { harness?: string; folderPath: string; model?: string | null; effort?: string | null }): Promise<StartLiveSessionResult> {
  const workspaceId = hostServices().workspaceId();
  if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };

  const harness = input.harness ?? DEFAULT_HARNESS_ID;
  if (!isHarnessId(harness)) return { ok: false, error: "Choose an agent from the list." };
  const { launcher } = registrationFor(harness);

  const folderPath = resolve(input.folderPath);
  if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) return { ok: false, error: "Choose a valid folder." };

  const remote = gitRemote(folderPath);
  const checked = await launcher.check();
  if (!checked.ok) return { ok: false, error: checked.error };
  if (!isKnownModel(harness, input.model)) return { ok: false, error: "Choose a model from the list." };
  if (!isEffortFor(harness, input.model, input.effort)) return { ok: false, error: "Choose a reasoning effort from the list." };

  const hostId = hostServices().hostId();
  const nativeSessionId = launcher.newNativeSessionId();
  const model = input.model ?? null;
  const effort = input.effort ?? null;
  const harnessVersion = checked.version;

  let sessionId: string;
  try {
    const created = await hostServices().fetchServerJSON<{ session: { id: string } }>(`workspaces/${workspaceId}/live-sessions`, {
      method: "POST",
      body: JSON.stringify({
        hostId,
        hostName: hostname(),
        folderName: basename(folderPath),
        gitRemote: await remote,
        harness,
        model,
        reasoningEffort: effort,
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
    hostId,
    nativeSessionId,
    folderPath,
    harness,
    cursors: {},
    rawUploads: {},
    ended: false,
    model,
    reasoningEffort: effort,
    harnessVersion,
  };

  try {
    state = { ...state, ...(await launcher.launch({ sessionId, workspace: { path: folderPath }, model, effort, nativeSessionId, options: { bin: checked.bin } })) };
  } catch (error) {
    console.error("[live-session] launch failed", error);
    await hostServices().fetchServer(`workspaces/${workspaceId}/live-sessions/${sessionId}/end`, {
      method: "POST",
      body: JSON.stringify({ hostId, reason: "launch_failed" }),
    }).catch(() => {});
    return { ok: false, error: error instanceof LaunchError ? error.message : launcher.launchFailedMessage };
  }

  saveState(state);
  new SessionHost(state).start();
  return { ok: true, sessionId };
}

/**
 * Runs a session whose server row already exists, such as a cloud session the backend created. `resume` continues the
 * saved conversation, `launch` starts a new one. Throws when the harness cannot start.
 */
export async function attachLiveSession(state: HostSessionState, mode: "launch" | "resume"): Promise<{ ok: true; session: AttachedSession } | { ok: false; error: string }> {
  const { launcher } = registrationFor(state.harness);
  const checked = await launcher.check();
  if (!checked.ok) return { ok: false, error: checked.error };
  const model = state.model ?? null;
  const effort = state.reasoningEffort ?? null;
  const options = { bin: checked.bin };
  const started =
    mode === "resume"
      ? await launcher.resume({ sessionId: state.sessionId, nativeSessionId: state.nativeSessionId, model, effort, options })
      : await launcher.launch({ sessionId: state.sessionId, workspace: { path: state.folderPath }, model, effort, nativeSessionId: state.nativeSessionId, options });
  const next: HostSessionState = { ...state, ...started, harnessVersion: checked.version };
  saveState(next);
  const session = new SessionHost(next);
  session.start();
  return { ok: true, session };
}

/** Starts an ended session of the owner again on this computer. It is the same session, live again. */
export async function resumeLiveSession(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspaceId = hostServices().workspaceId();
  if (!workspaceId) return { ok: false, error: "Sign in to Draft Cloud first." };
  if (running.get(sessionId) && !running.get(sessionId)!.hasEnded()) return { ok: false, error: "This session is already running." };

  let session: LiveSession & { native_session_id?: string | null; host_id?: string; end_reason?: string | null };
  try {
    session = (await hostServices().fetchServerJSON<LiveSessionEventsPage>(`${sessionBase(sessionId)}/events?after=0&limit=1`)).session as typeof session;
  } catch {
    return { ok: false, error: "Could not load the session." };
  }
  const hostId = hostServices().hostId();
  if (session.runtime === "cloud") return { ok: false, error: "Cloud sessions run in Draft Cloud. Nothing on this computer can resume them." };
  if (!session.mine) return { ok: false, error: "Only the person who started a session can resume it." };
  if (session.status !== "ended") return { ok: false, error: "This session is not ended." };
  if (session.end_reason === "cleared") return { ok: false, error: "This conversation was cleared. Open the session that continued it." };
  if (session.host_id !== hostId || !session.native_session_id) return { ok: false, error: "This session ran on another computer. Resume it there." };

  const harness = session.harness ?? DEFAULT_HARNESS_ID;
  if (!isHarnessId(harness)) return { ok: false, error: "This session's agent is not supported by this version of Draft." };
  const { launcher } = registrationFor(harness);
  const checked = await launcher.check();
  if (!checked.ok) return { ok: false, error: checked.error };

  try {
    await hostServices().fetchServer(`${sessionBase(sessionId)}/reopen`, { method: "POST", body: JSON.stringify({ hostId }) });
  } catch (error) {
    return { ok: false, error: error instanceof ServerError && error.code === "session_cleared" ? "This conversation was cleared." : "Could not reopen the session." };
  }

  let state: HostSessionState = {
    sessionId,
    workspaceId,
    hostId,
    nativeSessionId: session.native_session_id,
    folderPath: "",
    harness,
    cursors: {},
    rawUploads: {},
    ended: false,
    model: session.model ?? null,
    reasoningEffort: session.reasoning_effort ?? null,
    harnessVersion: checked.version,
  };
  try {
    state = { ...state, ...(await launcher.resume({ sessionId, nativeSessionId: session.native_session_id, model: state.model ?? null, effort: state.reasoningEffort ?? null, options: { bin: checked.bin } })) };
  } catch (error) {
    console.error("[live-session] resume failed", error);
    await hostServices().fetchServer(`${sessionBase(sessionId)}/end`, { method: "POST", body: JSON.stringify({ hostId, reason: "resume_failed" }) }).catch(() => {});
    return { ok: false, error: error instanceof LaunchError ? error.message : "Could not resume the session." };
  }

  saveState(state);
  new SessionHost(state).start();
  return { ok: true };
}

/** True when the server says the session runs in a Draft Cloud sandbox. If the server cannot say, it is treated as a computer session, as before. */
async function isCloudSession(sessionId: string): Promise<boolean> {
  try {
    const page = await hostServices().fetchServerJSON<LiveSessionEventsPage>(`${sessionBase(sessionId)}/events?after=0&limit=1`);
    return page.session.runtime === "cloud";
  } catch {
    return false;
  }
}

/** Picks up the sessions this machine was forwarding when the app last closed. A cloud session is never picked up here. */
export async function resumeLiveSessions(): Promise<void> {
  for (const state of loadStates()) {
    if (running.has(state.sessionId)) continue;
    if (await isCloudSession(state.sessionId)) continue;
    const runner = new SessionHost(state);
    runner.start();
    if (!state.ended && (await runner.isAlive())) await runner.uploadIfChanged();
  }
}

/** Hides the owner's session in Draft. A session that runs here ends first. Claude's own files stay. */
export async function deleteLiveSession(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const runner = running.get(sessionId);
    if (runner && !runner.hasEnded()) await runner.endByOwner();
    await hostServices().fetchServer(sessionBase(sessionId), { method: "DELETE" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "delete_failed" };
  }
}

export function sessionBase(sessionId: string): string {
  const workspaceId = hostServices().workspaceId();
  if (!workspaceId) throw new ServerError("signed_out");
  return `workspaces/${workspaceId}/live-sessions/${sessionId}`;
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

/** The folder a session on this computer works in, or an error when it is unknown. */
export function liveSessionFolder(sessionId: string): { ok: true; folderPath: string } | { ok: false; error: string } {
  const runner = running.get(sessionId);
  if (!runner || runner.hasEnded()) return { ok: false, error: "This session does not run on this computer." };
  const folderPath = runner.folderPath();
  if (!folderPath || !existsSync(folderPath)) return { ok: false, error: "The folder for this session was not found." };
  return { ok: true, folderPath };
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
