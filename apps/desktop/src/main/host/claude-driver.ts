import { ApprovalBroker } from "./approvals";
import { CLAUDE_MISSING_MESSAGE, CLAUDE_SIGNED_OUT_MESSAGE, readClaudeAuth } from "./claude-check";
import { ControlActions, type ControlInput } from "./controls";
import { findRunnerBin } from "./find-bin";
import { existsSync, readFileSync } from "fs";
import { TranscriptForwarder, findTranscript, type ForwardedLine } from "./forwarder";
import { LaunchError, type DriverHost, type HarnessDriver, type HarnessLauncher, type HarnessRegistration, type HostInput } from "./harness-driver";
import { writeSessionSettings } from "./hook-settings";
import { ensureHooksServer, registerSessionHooks } from "./hooks-server";
import { InputDelivery, type PendingInput } from "./input-delivery";
import { capturePane, killPane, launchClaudeInTmux, paneIsAlive, pasteIntoPane, pressEnter, pressEscape, restorePaneSize, tmuxSessionName } from "./launch";
import { openPaneInTerminal } from "./open-in-terminal";
import { classifyPane, isTurnRunning } from "./pane-state";
import { preTrustFolder } from "./pre-trust";
import { putSigned, uploadRawFiles } from "./raw-upload";
import { rotationTarget } from "./rotation";
import { readClaudeVersion } from "./version-check";
import { fetchServer, fetchServerJSON } from "../server/server-client";

const END_POLLS = 10;
const END_POLL_MS = 1_000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Claude Code in a tmux pane: lines come from its transcript, approvals from its hooks. */
export class ClaudeDriver implements HarnessDriver {
  private readonly forwarder: TranscriptForwarder;
  private readonly delivery: InputDelivery;
  private readonly broker: ApprovalBroker;
  private readonly controls: ControlActions;
  private unregisterHooks: (() => void) | null = null;
  private rotateTo: string | null = null;
  private caughtUp = false;
  private halted = false;

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
    this.broker = new ApprovalBroker({
      postEvents: (events) => host.postHostEvents(events),
      paneBlocked: async () => {
        const pane = classifyPane(await capturePane(this.tmux));
        return pane !== "ready" && pane !== "composer_busy";
      },
      newId: () => `r${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      onOpen: (id) => host.persist({ openRequests: [...(host.state().openRequests ?? []), id] }),
      onClose: (id) => host.persist({ openRequests: (host.state().openRequests ?? []).filter((open) => open !== id) }),
    });
    this.controls = new ControlActions({
      setState: host.setInputState,
      decide: (requestId, decision, by) => this.broker.decide(requestId, decision, by),
      capture: () => capturePane(this.tmux),
      sendEscape: () => pressEscape(this.tmux),
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
      stopped: () => this.host.requestUpload(),
      sessionStarted: (payload) => {
        this.rotateTo ??= rotationTarget(this.host.state().nativeSessionId, payload);
      },
    });
    for (const requestId of state.openRequests ?? []) {
      void this.broker.closeOnServer(requestId, { requestId, reason: "hook_gone" });
    }
    this.forwarder.start();
    void this.catchUp();
  }

  /** Input delivery waits until the transcript is up to date, so a sent message is not called uncertain too soon. */
  private async catchUp(): Promise<void> {
    while (!this.halted && !(await this.forwarder.tick())) await sleep(2_000);
    this.caughtUp = true;
  }

  halt(): void {
    this.halted = true;
    this.forwarder.halt();
  }

  dispose(): void {
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

  async serve(inputs: HostInput[]): Promise<void> {
    await restorePaneSize(this.tmux).catch(() => {});
    await this.broker.watchPane();
    await this.guarded("control actions", () => this.controls.tick(inputs.filter((i): i is ControlInput => i.kind !== "message")));
    if (!this.caughtUp) return;
    await this.guarded("input delivery", () => this.delivery.tick(inputs.filter((i): i is PendingInput => i.kind === "message")));
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
    if ((await readClaudeAuth(bin)) === "signed_out") return { ok: false, error: CLAUDE_SIGNED_OUT_MESSAGE };
    return { ok: true, bin, version: await readClaudeVersion(bin) };
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
