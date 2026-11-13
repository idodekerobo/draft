import { liveTextTopic, LIVE_TEXT_EVENT, type LiveTextChunk } from "draft-core/live-sessions";
import { ApprovalBroker } from "./approvals";
import { CLAUDE_MISSING_MESSAGE, CLAUDE_SIGNED_OUT_MESSAGE, readClaudeAuth } from "./claude-check";
import { ControlActions, type ControlInput } from "./controls";
import { findRunnerBin } from "./find-bin";
import { existsSync, readFileSync } from "fs";
import { TranscriptForwarder, findTranscript, type ForwardedLine } from "./forwarder";
import { LaunchError, type DriverHost, type HarnessDriver, type HarnessLauncher, type HarnessRegistration, type HostInput } from "./harness-driver";
import { DeltaTail } from "./delta-tail";
import { writeSessionSettings } from "./hook-settings";
import { deltasPath, ensureHooksServer, registerSessionHooks } from "./hooks-server";
import { InputDelivery, type PendingInput } from "./input-delivery";
import { LeadInRelay } from "./lead-in";
import { LiveTextRelay } from "./live-text-relay";
import { capturePane, killPane, launchClaudeInTmux, paneIsAlive, pasteIntoPane, pressBackTab, pressEnter, pressEscape, restorePaneSize, tmuxSessionName } from "./launch";
import { openPaneInTerminal } from "./open-in-terminal";
import { realtime } from "../realtime/instance";
import { CYCLE_MODES, modeFromScreen, switchMode, type ClaudeMode } from "./mode";
import { classifyPane, isTurnRunning } from "./pane-state";
import { preTrustFolder } from "./pre-trust";
import { putSigned, uploadRawFiles } from "./raw-upload";
import { rotationTarget } from "./rotation";
import { readClaudeVersion } from "./version-check";
import { fetchServer, fetchServerJSON } from "../server/server-client";

const END_POLLS = 10;
const END_POLL_MS = 1_000;
const IDLE_POLL_MS = 2_000;
const QUEUED_POLL_MS = 250;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Claude Code in a tmux pane: lines come from its transcript, approvals from its hooks. */
export class ClaudeDriver implements HarnessDriver {
  private readonly forwarder: TranscriptForwarder;
  private readonly delivery: InputDelivery;
  private readonly broker: ApprovalBroker;
  private readonly leadIn: LeadInRelay;
  private readonly controls: ControlActions;
  private readonly relay: LiveTextRelay;
  private readonly deltas: DeltaTail;
  private unregisterHooks: (() => void) | null = null;
  private rotateTo: string | null = null;
  private caughtUp = false;
  private halted = false;
  private waiting = false;

  constructor(private readonly host: DriverHost) {
    const state = host.state();
    this.forwarder = new TranscriptForwarder({
      nativeSessionId: state.nativeSessionId,
      cursors: state.cursors,
      onCursors: (cursors) => host.persist({ cursors }),
      post: (lines: ForwardedLine[]) => host.postLines(lines),
      isFatal: (error) => host.isFatal(error),
      onFatal: (error) => host.onFatal(error),
    });
    this.delivery = new InputDelivery({
      setState: host.setInputState,
      capture: () => capturePane(this.tmux),
      paste: (text) => pasteIntoPane(this.tmux, text),
      pressEnter: () => pressEnter(this.tmux),
      sleep,
    });
    this.leadIn = new LeadInRelay((events) => host.postHostEvents(events));
    this.relay = new LiveTextRelay({
      send: (chunk: LiveTextChunk) => realtime.send(liveTextTopic(host.state().sessionId), LIVE_TEXT_EVENT, chunk),
    });
    this.deltas = new DeltaTail({
      path: deltasPath(state.hookId ?? state.sessionId),
      onPayload: (payload) => {
        this.leadIn.message(payload);
        this.relayDelta(payload);
      },
    });
    this.broker = new ApprovalBroker({
      postEvents: (events) => host.postHostEvents(events),
      paneBlocked: async () => {
        const pane = classifyPane(await capturePane(this.tmux));
        return pane !== "ready" && pane !== "composer_busy";
      },
      oneAtATime: true,
      newId: () => `r${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      onOpen: (id) => host.persist({ openRequests: [...(host.state().openRequests ?? []), id] }),
      onHold: () => this.leadIn.requestOpened(),
      onRelease: () => this.leadIn.requestClosed(),
      onClose: (id) => host.persist({ openRequests: (host.state().openRequests ?? []).filter((open) => open !== id) }),
    });
    this.controls = new ControlActions({
      setState: host.setInputState,
      decide: (requestId, decision, by, extras) => this.broker.decide(requestId, decision, by, extras),
      capture: () => capturePane(this.tmux),
      sendEscape: () => pressEscape(this.tmux),
      setMode: (modes) => this.setMode(modes.permissionMode),
      postEvents: (events) => host.postHostEvents(events),
    });
  }

  private get tmux(): string {
    return this.host.state().tmuxSession ?? "";
  }

  start(): void {
    const state = this.host.state();
    ensureHooksServer();
    this.unregisterHooks = registerSessionHooks(state.hookId ?? state.sessionId, {
      permission: (payload, signal) => this.broker.hold(payload, signal),
      stopped: () => {
        this.host.requestUpload();
        if (this.waiting) this.host.wake();
      },
      sessionStarted: (payload) => {
        this.rotateTo ??= rotationTarget(this.host.state().nativeSessionId, payload);
      },
    });
    this.deltas.start();
    for (const requestId of state.openRequests ?? []) {
      void this.broker.closeOnServer(requestId, { requestId, reason: "hook_gone" });
    }
    this.forwarder.start();
    void this.catchUp();
  }

  /** Sends one streamed chunk to viewers, when it belongs to this conversation's current message. */
  private relayDelta(payload: Record<string, unknown>): void {
    const { session_id: sessionId, message_id: messageId, delta, final } = payload;
    if (sessionId !== undefined && sessionId !== this.host.state().nativeSessionId) return;
    if (typeof messageId !== "string" || messageId === "" || typeof delta !== "string") return;
    this.relay.push(messageId, delta, final === true);
  }

  /** Input delivery waits until the transcript is up to date, so a sent message is not called uncertain too soon. */
  private async catchUp(): Promise<void> {
    while (!this.halted && !(await this.forwarder.tick())) await sleep(2_000);
    this.caughtUp = true;
  }

  halt(): void {
    this.halted = true;
    this.forwarder.halt();
    this.deltas.stop();
    this.relay.stop();
  }

  dispose(): void {
    this.deltas.stop(true);
    this.halt();
    this.unregisterHooks?.();
  }

  isAlive(): Promise<boolean> {
    return paneIsAlive(this.tmux);
  }

  flush(): Promise<boolean> {
    this.forwarder.halt();
    return this.forwarder.tick();
  }

  pollMs(): number {
    return this.waiting ? QUEUED_POLL_MS : IDLE_POLL_MS;
  }

  async serve(inputs: HostInput[]): Promise<void> {
    this.waiting = inputs.some((i) => i.kind === "message" && i.state === "queued");
    await restorePaneSize(this.tmux).catch(() => {});
    await this.broker.watchPane();
    await this.guarded("mode watch", () => this.watchMode());
    await this.guarded("control actions", () => this.controls.tick(inputs.filter((i): i is ControlInput => i.kind !== "message")));
    if (!this.caughtUp) return;
    await this.guarded("input delivery", () => this.delivery.tick(inputs.filter((i): i is PendingInput => i.kind === "message")));
  }

  /** Reports the mode in the footer, so a switch with Shift+Tab in the terminal reaches the chat too. */
  private async watchMode(): Promise<void> {
    const mode = modeFromScreen(await capturePane(this.tmux));
    if (mode) this.host.reportModes({ permissionMode: mode });
  }

  private async setMode(target: string | undefined): Promise<{ ok: true } | { ok: false; note: string }> {
    if (!target || !CYCLE_MODES.has(target)) return { ok: false, note: "That mode cannot be set from Draft." };
    const screen = await capturePane(this.tmux);
    const pane = classifyPane(screen);
    if (pane !== "ready" && pane !== "composer_busy") return { ok: false, note: `Claude is waiting on a prompt, so the mode did not change. Answer it first.` };
    const result = await switchMode(
      target as ClaudeMode,
      { capture: () => capturePane(this.tmux), pressBackTab: () => pressBackTab(this.tmux), sleep },
      screen,
    );
    if (result.mode) this.host.reportModes({ permissionMode: result.mode });
    if (result.ok) return { ok: true };
    return { ok: false, note: result.reason === "unreadable" ? "Could not read Claude's mode, so it did not change." : "Could not reach that mode from Draft. Claude's own mode list does not include it." };
  }

  private async guarded(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.host.reportError(what, error);
    }
  }

  rotationTarget(): string | null {
    return this.rotateTo;
  }

  clearRotation(): void {
    this.rotateTo = null;
  }

  /** Forwards what is new, then uploads the raw transcript files. */
  async finalize(): Promise<boolean> {
    try {
      const rawUploads = await uploadRawFiles(this.forwarder.files(), this.host.state().rawUploads, {
        requestUrls: async (files) =>
          (await fetchServerJSON<{ uploads: Array<{ file: string; signedUrl: string }> }>(`${this.host.base}/raw`, {
            method: "POST",
            body: JSON.stringify({ hostMachineId: this.host.state().hostMachineId, files }),
          })).uploads,
        put: putSigned,
        complete: async () => {
          await fetchServer(`${this.host.base}/raw/complete`, {
            method: "POST",
            body: JSON.stringify({ hostMachineId: this.host.state().hostMachineId }),
          });
        },
      });
      if (rawUploads !== this.host.state().rawUploads) this.host.persist({ rawUploads });
      return true;
    } catch (error) {
      this.host.reportError("raw upload", error);
      return false;
    }
  }

  refresh(): Promise<boolean> {
    return this.forwarder.tick();
  }

  /** Exits Claude with `/exit` so its own end-of-session hook runs. A pane that will not take it is killed. */
  async stop(): Promise<void> {
    const tmux = this.tmux;
    let screen = await capturePane(tmux);
    if (isTurnRunning(screen) || classifyPane(screen) !== "ready") {
      await pressEscape(tmux).catch(() => {});
      await sleep(1000);
      screen = await capturePane(tmux).catch(() => "");
    }
    if (classifyPane(screen) === "ready" && !isTurnRunning(screen)) {
      await pasteIntoPane(tmux, "/exit");
      await pressEnter(tmux);
      for (let i = 0; i < END_POLLS && (await paneIsAlive(tmux)); i++) await sleep(END_POLL_MS);
    }
    if (await paneIsAlive(tmux)) await killPane(tmux);
  }

  openInTerminal(): Promise<{ ok: true } | { ok: false; error: string }> {
    return openPaneInTerminal(this.tmux);
  }
}

/** The `cwd` Claude records on the lines of its transcript. */
function folderOfTranscript(path: string): string | null {
  for (const line of readFileSync(path, "utf8").split("\n", 50)) {
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
    if (cwd) return JSON.parse(`"${cwd}"`) as string;
  }
  return null;
}

const launcher: HarnessLauncher = {
  id: "claude",
  launchFailedMessage: "Could not start Claude Code.",
  async check() {
    const bin = findRunnerBin("claude");
    if (!bin) return { ok: false, error: CLAUDE_MISSING_MESSAGE };
    const [auth, version] = await Promise.all([readClaudeAuth(bin), readClaudeVersion(bin)]);
    if (auth === "signed_out") return { ok: false, error: CLAUDE_SIGNED_OUT_MESSAGE };
    return { ok: true, bin, version };
  },
  newNativeSessionId: () => crypto.randomUUID(),
  async resume({ sessionId, nativeSessionId, model, bin }) {
    // The transcript says which folder the conversation ran in, and Claude finds it only from there.
    const transcript = findTranscript(nativeSessionId);
    const folderPath = transcript ? folderOfTranscript(transcript) : null;
    if (!folderPath || !existsSync(folderPath)) throw new LaunchError("This conversation is not on this computer, or its folder is gone.");
    const tmuxSession = tmuxSessionName(sessionId);
    if (await paneIsAlive(tmuxSession)) throw new LaunchError("This session is already running.");
    preTrustFolder(folderPath);
    const settingsPath = writeSessionSettings(sessionId);
    await launchClaudeInTmux({ tmuxSession, folderPath, claudeBin: bin, nativeSessionId, model, settingsPath, resume: true });
    return { folderPath, tmuxSession };
  },
  async launch({ sessionId, folderPath, model, bin, nativeSessionId }) {
    const tmuxSession = tmuxSessionName(sessionId);
    preTrustFolder(folderPath);
    const settingsPath = writeSessionSettings(sessionId);
    await launchClaudeInTmux({ tmuxSession, folderPath, claudeBin: bin, nativeSessionId, model, settingsPath });
    return { tmuxSession };
  },
};

export const claude: HarnessRegistration = { launcher, createDriver: (host) => new ClaudeDriver(host) };
