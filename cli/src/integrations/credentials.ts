import { closeSync, createReadStream, openSync, read, writeSync } from "fs";
import type { Readable } from "stream";
import { finished } from "stream/promises";

export const MAX_CREDENTIAL_BYTES = 65_536;

export type CredentialProvider = "fireflies" | "linear" | "slack" | "claude-code";
export type CredentialSource =
  | { kind: "tty" }
  | { kind: "stdin" }
  | { kind: "fd"; fd: number };

export interface ProviderCredentials {
  fireflies: { api_token: string };
  linear: { api_key: string };
  slack: { bot_token: string; app_token: string };
  "claude-code": { setup_token: string };
}

export type CredentialInputErrorCode =
  | "credential_input_required"
  | "invalid_credential_input"
  | "interrupted";

export class CredentialInputError extends Error {
  constructor(public readonly code: CredentialInputErrorCode) {
    super(code);
    this.name = "CredentialInputError";
  }
}

export interface ParsedCredentialSourceOptions {
  source: CredentialSource;
  remaining: string[];
}

export function parseCredentialSourceOptions(args: readonly string[]): ParsedCredentialSourceOptions {
  let source: CredentialSource | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--credential-stdin") {
      if (source) throw new CredentialInputError("invalid_credential_input");
      source = { kind: "stdin" };
      continue;
    }
    if (arg === "--credential-fd") {
      if (source) throw new CredentialInputError("invalid_credential_input");
      const rawFd = args[++index];
      if (!rawFd || !/^(0|[1-9]\d*)$/.test(rawFd)) {
        throw new CredentialInputError("invalid_credential_input");
      }
      const fd = Number(rawFd);
      if (fd < 3 || fd > 1024) throw new CredentialInputError("invalid_credential_input");
      source = { kind: "fd", fd };
      continue;
    }
    if (arg.startsWith("--credential-")) {
      throw new CredentialInputError("invalid_credential_input");
    }
    remaining.push(arg);
  }
  return { source: source ?? { kind: "tty" }, remaining };
}

export interface CredentialReader {
  preflightTty(): Promise<boolean>;
  read<P extends CredentialProvider>(provider: P, source: CredentialSource): Promise<ProviderCredentials[P]>;
}

export interface CredentialTerminalOps {
  openTty(): number;
  duplicateFd(fd: number): { fd: number; owned: boolean };
  close(fd: number): void;
  write(fd: number, value: string): void;
  read(fd: number, buffer: Uint8Array, offset: number, length: number): Promise<number>;
  createTtySession(fd: number): TtyReadSession;
  runStty(args: string[], fd: number): Promise<{ exitCode: number; stdout: string }>;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
}

export interface TtyReadSession {
  readLine(maxBytes: number): Promise<Uint8Array>;
  cancel(): void;
  close(): Promise<void>;
}

export class StreamTtyReadSession implements TtyReadSession {
  private readonly stream: Readable;
  private readonly iterator;
  private chunk = new Uint8Array();
  private offset = 0;
  private closed = false;

  constructor(fd: number, stream?: Readable) {
    this.stream = stream ?? createReadStream("/dev/null", { fd, autoClose: false });
    this.iterator = this.stream[Symbol.asyncIterator]();
  }

  async readLine(maxBytes: number): Promise<Uint8Array> {
    const output = new Uint8Array(maxBytes + 1);
    let length = 0;
    try {
      for (;;) {
        if (this.offset >= this.chunk.length) {
          this.chunk.fill(0);
          const next = await this.iterator.next();
          if (next.done) break;
          this.chunk = next.value;
          this.offset = 0;
        }
        const byte = this.chunk[this.offset++]!;
        if (byte === 0x0a) break;
        if (length === maxBytes) throw new CredentialInputError("invalid_credential_input");
        output[length++] = byte;
      }
      if (length > 0 && output[length - 1] === 0x0d) length--;
      return output.slice(0, length);
    } finally {
      output.fill(0);
    }
  }

  cancel(): void {
    if (!this.closed) this.stream.destroy();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream.destroy();
    try { await this.iterator.return?.(); } catch {}
    try { await finished(this.stream); } catch {}
    this.chunk.fill(0);
    this.chunk = new Uint8Array();
    this.offset = 0;
  }
}

const defaultTerminalOps: CredentialTerminalOps = {
  openTty: () => openSync("/dev/tty", "r+"),
  duplicateFd: (fd) => {
    try {
      return { fd: openSync(`/dev/fd/${fd}`, "r"), owned: true };
    } catch {
      // Some POSIX targets cannot reopen /dev/fd; the inherited descriptor remains caller-owned.
      return { fd, owned: false };
    }
  },
  close: (fd) => closeSync(fd),
  write: (fd, value) => { writeSync(fd, value); },
  read: (fd, buffer, offset, length) => new Promise((resolve, reject) => {
    read(fd, buffer, offset, length, null, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  }),
  createTtySession: (fd) => new StreamTtyReadSession(fd),
  runStty: async (args, fd) => {
    const process = Bun.spawn({
      cmd: ["/bin/stty", ...args],
      stdin: fd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    return { exitCode, stdout };
  },
  onSignal: (signal, handler) => { process.on(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
};

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function decodeProviderCredentials<P extends CredentialProvider>(
  provider: P,
  value: unknown,
): ProviderCredentials[P] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialInputError("invalid_credential_input");
  }
  const input = value as Record<string, unknown>;
  if (provider === "fireflies" && exactKeys(input, ["api_token"]) && nonemptyString(input.api_token)) {
    return { api_token: input.api_token } as ProviderCredentials[P];
  }
  if (provider === "linear" && exactKeys(input, ["api_key"]) && nonemptyString(input.api_key)) {
    return { api_key: input.api_key } as ProviderCredentials[P];
  }
  if (
    provider === "slack" &&
    exactKeys(input, ["app_token", "bot_token"]) &&
    nonemptyString(input.bot_token) &&
    nonemptyString(input.app_token)
  ) {
    return { bot_token: input.bot_token, app_token: input.app_token } as ProviderCredentials[P];
  }
  if (provider === "claude-code" && exactKeys(input, ["setup_token"]) && nonemptyString(input.setup_token)) {
    return { setup_token: input.setup_token } as ProviderCredentials[P];
  }
  throw new CredentialInputError("invalid_credential_input");
}

function decodeUtf8(buffer: Uint8Array, length: number): string {
  if (length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new CredentialInputError("invalid_credential_input");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } catch {
    throw new CredentialInputError("invalid_credential_input");
  }
}

export class PosixCredentialReader implements CredentialReader {
  constructor(private readonly ops: CredentialTerminalOps = defaultTerminalOps) {}

  async preflightTty(): Promise<boolean> {
    let fd: number | undefined;
    try {
      fd = this.ops.openTty();
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) this.ops.close(fd);
    }
  }

  async read<P extends CredentialProvider>(
    provider: P,
    source: CredentialSource,
  ): Promise<ProviderCredentials[P]> {
    try {
      if (source.kind === "tty") return await this.readFromTty(provider);
      return await this.readAutomation(provider, source);
    } catch (error) {
      if (error instanceof CredentialInputError) throw error;
      throw new CredentialInputError("invalid_credential_input");
    }
  }

  private async readAutomation<P extends CredentialProvider>(
    provider: P,
    source: Extract<CredentialSource, { kind: "stdin" | "fd" }>,
  ): Promise<ProviderCredentials[P]> {
    const duplicate = source.kind === "stdin"
      ? { fd: 0, owned: false }
      : this.ops.duplicateFd(source.fd);
    const buffer = new Uint8Array(MAX_CREDENTIAL_BYTES + 1);
    try {
      let length = 0;
      while (length < buffer.length) {
        const bytesRead = await this.ops.read(duplicate.fd, buffer, length, buffer.length - length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_CREDENTIAL_BYTES) throw new CredentialInputError("invalid_credential_input");
      const text = decodeUtf8(buffer, length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CredentialInputError("invalid_credential_input");
      }
      return decodeProviderCredentials(provider, parsed);
    } finally {
      // Mutable input buffers are zeroed; immutable JavaScript strings cannot be reliably zeroized.
      buffer.fill(0);
      if (duplicate.owned) this.ops.close(duplicate.fd);
    }
  }

  private async readFromTty<P extends CredentialProvider>(provider: P): Promise<ProviderCredentials[P]> {
    let fd: number;
    try {
      fd = this.ops.openTty();
    } catch {
      throw new CredentialInputError("credential_input_required");
    }

    let terminalMode: string | undefined;
    let echoDisabled = false;
    let restored = false;
    let interrupted = false;
    let awaitingRead = false;
    // Only true if the interrupt arrived while a native read was genuinely
    // in flight -- that's the one case a stuck read can't be cancelled and
    // session.close() (which waits on that same read settling) could hang.
    // An interrupt at any other time (e.g. during a close that's already in
    // progress after a successful read) isn't at risk, so it keeps the
    // normal cleanup path.
    let hungReadAbandoned = false;
    let session: TtyReadSession | undefined;
    let rejectInterrupt: ((error: CredentialInputError) => void) | undefined;
    const interruptSignal = new Promise<never>((_resolve, reject) => { rejectInterrupt = reject; });
    // Swallow rejection on this promise specifically -- Promise.race below
    // attaches its own handling, but if nothing ever rejects it (the happy
    // path), an unused executor-only promise is fine; this just guards
    // against an unhandledRejection warning if interrupt fires very early.
    interruptSignal.catch(() => {});
    const onSignal = () => {
      if (interrupted) return;
      interrupted = true;
      if (awaitingRead) hungReadAbandoned = true;
      try { session?.cancel(); } catch {}
      rejectInterrupt?.(new CredentialInputError("interrupted"));
    };
    const throwIfInterrupted = () => {
      if (interrupted) throw new CredentialInputError("interrupted");
    };
    const restore = async () => {
      if (restored || !echoDisabled) return;
      restored = true;
      let restoredMode = false;
      if (terminalMode) {
        try {
          restoredMode = (await this.ops.runStty([terminalMode], fd)).exitCode === 0;
        } catch {}
      }
      if (!restoredMode) {
        try { await this.ops.runStty(["echo"], fd); } catch {}
      }
    };

    this.ops.onSignal("SIGINT", onSignal);
    this.ops.onSignal("SIGTERM", onSignal);
    try {
      const captured = await this.ops.runStty(["-g"], fd);
      throwIfInterrupted();
      const capturedMode = captured.stdout.trim();
      if (captured.exitCode !== 0 || capturedMode.length === 0) {
        throw new CredentialInputError("credential_input_required");
      }
      terminalMode = capturedMode;
      const hidden = await this.ops.runStty(["-echo"], fd);
      echoDisabled = hidden.exitCode === 0;
      throwIfInterrupted();
      if (!echoDisabled) throw new CredentialInputError("credential_input_required");
      session = this.ops.createTtySession(fd);

      const prompt = async (label: string): Promise<string> => {
        this.ops.write(fd, label);
        // A read already dispatched to the OS on a TTY fd cannot be cancelled
        // by destroying the stream -- it only settles once more input
        // arrives. Race it against the interrupt so Ctrl-C takes effect
        // immediately instead of waiting for a keystroke that may never come;
        // the loser is abandoned (never awaited further) but still given a
        // catch handler so its eventual settlement can't surface as an
        // unhandled rejection.
        const readPromise = session!.readLine(MAX_CREDENTIAL_BYTES);
        readPromise.catch(() => {});
        awaitingRead = true;
        let bytes: Uint8Array;
        try {
          bytes = await Promise.race([readPromise, interruptSignal]);
        } catch (error) {
          throwIfInterrupted();
          throw error;
        } finally {
          awaitingRead = false;
        }
        throwIfInterrupted();
        let value: string;
        try {
          value = decodeUtf8(bytes, bytes.length);
        } finally {
          bytes.fill(0);
        }
        this.ops.write(fd, "\n");
        if (value.length === 0) throw new CredentialInputError("invalid_credential_input");
        return value;
      };

      const writeGuidance = (lines: string[]) => {
        for (const line of lines) this.ops.write(fd, `${line}\n`);
        this.ops.write(fd, "\n");
      };

      if (provider === "fireflies") {
        writeGuidance([
          "Get your Fireflies API key: https://app.fireflies.ai/settings/developer-settings",
          "This is a secure, hidden prompt -- your key won't be echoed to the screen.",
          "Press Ctrl+C to cancel.",
        ]);
        return { api_token: await prompt("Fireflies API token:") } as ProviderCredentials[P];
      }
      if (provider === "linear") {
        writeGuidance([
          "Get your Linear API key: https://linear.app/settings/api",
          "This is a secure, hidden prompt -- your key won't be echoed to the screen.",
          "Press Ctrl+C to cancel.",
        ]);
        return { api_key: await prompt("Linear API key:") } as ProviderCredentials[P];
      }
      if (provider === "slack") {
        writeGuidance([
          "In the Slack app page just opened: install the app to your workspace, then find --",
          "  Bot token -- OAuth & Permissions -> OAuth Tokens (starts with xoxb-)",
          "  App token -- Basic Information -> App-Level Tokens, with the connections:write scope (starts with xapp-)",
          "These are secure, hidden prompts -- tokens won't be echoed to the screen.",
          "Press Ctrl+C to cancel.",
        ]);
        const botToken = await prompt("Slack bot token (xoxb-):");
        const appToken = await prompt("Slack app token (xapp-):");
        return { bot_token: botToken, app_token: appToken } as ProviderCredentials[P];
      }
      writeGuidance([
        "Install the Claude Code CLI (https://code.claude.com/docs/en/quickstart), then run",
        "'claude setup-token' in your terminal and paste the result below.",
        "This is a secure, hidden prompt -- the token won't be echoed to the screen.",
        "Press Ctrl+C to cancel.",
      ]);
      return { setup_token: await prompt("Claude Code setup token:") } as ProviderCredentials[P];
    } finally {
      try { session?.cancel(); } catch {}
      await restore();
      if (hungReadAbandoned) {
        // The abandoned read is still native-blocked on this fd, and
        // session.close() would wait on that same read settling (it never
        // will, until more input arrives) -- so it's skipped entirely here,
        // to avoid readFromTty itself hanging. This still just throws
        // (rather than force-exiting the process) so the caller gets a
        // chance to print/emit its own interrupted message first -- see
        // each provider's exitProcess call, made only after that happens.
        try { this.ops.offSignal("SIGINT", onSignal); } catch {}
        try { this.ops.offSignal("SIGTERM", onSignal); } catch {}
        try { this.ops.close(fd); } catch {}
        throw new CredentialInputError("interrupted");
      }
      try { await session?.close(); } catch {}
      const cleanupInterrupted = interrupted;
      try { this.ops.offSignal("SIGINT", onSignal); } catch {}
      try { this.ops.offSignal("SIGTERM", onSignal); } catch {}
      try { this.ops.close(fd); } catch {}
      if (cleanupInterrupted) throw new CredentialInputError("interrupted");
    }
  }
}

export const credentialReader: CredentialReader = new PosixCredentialReader();
