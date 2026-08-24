import { describe, expect, it } from "bun:test";
import { Readable } from "stream";
import { join } from "path";
import {
  CredentialInputError,
  MAX_CREDENTIAL_BYTES,
  PosixCredentialReader,
  StreamTtyReadSession,
  parseCredentialSourceOptions,
  type CredentialTerminalOps,
  type TtyReadSession,
} from "../integrations/credentials.ts";
import { PosixBrowserLauncher } from "../integrations/browser.ts";

const encoder = new TextEncoder();

class FakeTtySession implements TtyReadSession {
  readCalls = 0;
  cancelCalls = 0;
  closeCalls = 0;
  private pendingReject?: (error: Error) => void;
  closeImpl?: () => Promise<void>;

  constructor(private readonly lines: Uint8Array[] = [], private readonly block = false) {}

  readLine(): Promise<Uint8Array> {
    this.readCalls++;
    if (this.block) {
      return new Promise((_resolve, reject) => { this.pendingReject = reject; });
    }
    return Promise.resolve(this.lines.shift() ?? new Uint8Array());
  }

  cancel(): void {
    if (this.cancelCalls++ > 0) return;
    this.pendingReject?.(new Error("cancelled"));
  }

  async close(): Promise<void> {
    this.closeCalls++;
    await this.closeImpl?.();
  }
}

interface FakeOpsState {
  input: Uint8Array;
  offset: number;
  order: string[];
  closed: number[];
  writes: string[];
  signals: Map<string, () => void>;
  buffers: Uint8Array[];
  session: FakeTtySession;
  duplicate: { fd: number; owned: boolean };
  restoreFails: boolean;
  captureFails: boolean;
  hideFails: boolean;
}

function fakeOps(options: Partial<FakeOpsState> = {}): { ops: CredentialTerminalOps; state: FakeOpsState } {
  const state: FakeOpsState = {
    input: new Uint8Array(),
    offset: 0,
    order: [],
    closed: [],
    writes: [],
    signals: new Map(),
    buffers: [],
    session: new FakeTtySession(),
    duplicate: { fd: 99, owned: true },
    restoreFails: false,
    captureFails: false,
    hideFails: false,
    ...options,
  };
  const ops: CredentialTerminalOps = {
    openTty: () => { state.order.push("open"); return 42; },
    duplicateFd: (fd) => { state.order.push(`duplicate:${fd}`); return state.duplicate; },
    close: (fd) => { state.order.push(`close:${fd}`); state.closed.push(fd); },
    write: (_fd, value) => { state.order.push(`write:${value}`); state.writes.push(value); },
    read: async (fd, buffer, offset, length) => {
      state.order.push(`read:${fd}`);
      state.buffers.push(buffer);
      const count = Math.min(length, state.input.length - state.offset);
      if (count <= 0) return 0;
      buffer.set(state.input.subarray(state.offset, state.offset + count), offset);
      state.offset += count;
      return count;
    },
    createTtySession: () => { state.order.push("session"); return state.session; },
    runStty: async (args) => {
      state.order.push(`stty:${args.join(" ")}`);
      if (args[0] === "-g") return state.captureFails
        ? { exitCode: 1, stdout: "untrusted-mode\n" }
        : { exitCode: 0, stdout: "opaque-mode\n" };
      if (args[0] === "-echo" && state.hideFails) return { exitCode: 1, stdout: "" };
      if (args[0] === "opaque-mode" && state.restoreFails) return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "" };
    },
    onSignal: (signal, handler) => { state.order.push(`on:${signal}`); state.signals.set(signal, handler); },
    offSignal: (signal) => { state.order.push(`off:${signal}`); state.signals.delete(signal); },
  };
  return { ops, state };
}

async function expectCredentialError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "CredentialInputError", code });
}

describe("credential source parsing", () => {
  it("defaults to TTY and extracts one explicit stdin or canonical fd source", () => {
    expect(parseCredentialSourceOptions(["--json"])).toEqual({ source: { kind: "tty" }, remaining: ["--json"] });
    expect(parseCredentialSourceOptions(["--credential-stdin", "--json"])).toEqual({
      source: { kind: "stdin" },
      remaining: ["--json"],
    });
    expect(parseCredentialSourceOptions(["--json", "--credential-fd", "1024"])).toEqual({
      source: { kind: "fd", fd: 1024 },
      remaining: ["--json"],
    });
  });

  it.each([
    { args: ["--credential-stdin", "--credential-stdin"] },
    { args: ["--credential-stdin", "--credential-fd", "3"] },
    { args: ["--credential-fd", "3", "--credential-fd", "4"] },
    { args: ["--credential-fd"] },
    { args: ["--credential-fd", "0"] },
    { args: ["--credential-fd", "1"] },
    { args: ["--credential-fd", "2"] },
    { args: ["--credential-fd", "1025"] },
    { args: ["--credential-fd", "03"] },
    { args: ["--credential-fd", "+3"] },
    { args: ["--credential-fd", "3.0"] },
    { args: ["--credential-fd=3"] },
    { args: ["--credential-file", "secret.json"] },
  ])("rejects conflicting or noncanonical source options: $args", ({ args }) => {
    expect(() => parseCredentialSourceOptions(args)).toThrow(CredentialInputError);
  });
});

describe("automation credential input", () => {
  it.each([
    ["fireflies", { api_token: " fireflies-secret " }],
    ["linear", { api_key: "linear-secret" }],
    ["slack", { bot_token: "xoxb-secret", app_token: "xapp-secret" }],
    ["claude-code", { setup_token: "setup-secret" }],
  ] as const)("accepts the exact %s schema and preserves strings", async (provider, credentials) => {
    const { ops } = fakeOps({ input: encoder.encode(` \n${JSON.stringify(credentials)}\t`) });
    await expect(new PosixCredentialReader(ops).read(provider, { kind: "stdin" })).resolves.toEqual(credentials);
  });

  it.each([
    "",
    "[]",
    "null",
    "{}",
    '{"api_key":""}',
    '{"api_key":1}',
    '{"api_token":"wrong-provider"}',
    '{"api_key":"ok","extra":"no"}',
    '{"api_key":"one"}{"api_key":"two"}',
    '{"api_key":"one"} trailing',
  ])("rejects invalid Linear JSON input: %s", async (input) => {
    const { ops } = fakeOps({ input: encoder.encode(input) });
    await expectCredentialError(
      new PosixCredentialReader(ops).read("linear", { kind: "stdin" }),
      "invalid_credential_input",
    );
  });

  it("rejects UTF-8 BOM, U+FEFF prefix, and malformed UTF-8", async () => {
    for (const input of [
      new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"api_key":"secret"}')]),
      encoder.encode('\uFEFF{"api_key":"secret"}'),
      new Uint8Array([0xc3, 0x28]),
    ]) {
      const { ops } = fakeOps({ input });
      await expectCredentialError(
        new PosixCredentialReader(ops).read("linear", { kind: "stdin" }),
        "invalid_credential_input",
      );
    }
  });

  it("accepts exactly 65,536 bytes and rejects the one-byte overflow", async () => {
    const emptySize = encoder.encode(JSON.stringify({ api_key: "" })).length;
    const exact = encoder.encode(JSON.stringify({ api_key: "a".repeat(MAX_CREDENTIAL_BYTES - emptySize) }));
    expect(exact).toHaveLength(MAX_CREDENTIAL_BYTES);
    const accepted = fakeOps({ input: exact });
    await expect(new PosixCredentialReader(accepted.ops).read("linear", { kind: "stdin" })).resolves.toMatchObject({
      api_key: expect.any(String),
    });

    const overflow = fakeOps({ input: new Uint8Array([...exact, 0x20]) });
    await expectCredentialError(
      new PosixCredentialReader(overflow.ops).read("linear", { kind: "stdin" }),
      "invalid_credential_input",
    );
  });

  it("never closes stdin or an inherited fallback fd, and closes only an owned duplicate", async () => {
    const stdin = fakeOps({ input: encoder.encode('{"api_key":"secret"}') });
    await new PosixCredentialReader(stdin.ops).read("linear", { kind: "stdin" });
    expect(stdin.state.closed).toEqual([]);

    const duplicate = fakeOps({ input: encoder.encode('{"api_key":"secret"}') });
    await new PosixCredentialReader(duplicate.ops).read("linear", { kind: "fd", fd: 7 });
    expect(duplicate.state.order).toContain("duplicate:7");
    expect(duplicate.state.closed).toEqual([99]);

    const fallback = fakeOps({
      input: encoder.encode('{"api_key":"secret"}'),
      duplicate: { fd: 7, owned: false },
    });
    await new PosixCredentialReader(fallback.ops).read("linear", { kind: "fd", fd: 7 });
    expect(fallback.state.closed).toEqual([]);
  });

  it("zeroes mutable input buffers after success and failure", async () => {
    for (const input of [encoder.encode('{"api_key":"secret"}'), encoder.encode("invalid")]) {
      const fake = fakeOps({ input });
      try { await new PosixCredentialReader(fake.ops).read("linear", { kind: "stdin" }); } catch {}
      expect(fake.state.buffers.length).toBeGreaterThan(0);
      expect(fake.state.buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    }
  });
});

describe("TTY credential input", () => {
  it("preflights and closes the probe descriptor exactly once", async () => {
    const fake = fakeOps();
    await expect(new PosixCredentialReader(fake.ops).preflightTty()).resolves.toBe(true);
    expect(fake.state.closed).toEqual([42]);
  });

  it("returns credential_input_required without installing handlers when /dev/tty is unavailable", async () => {
    const fake = fakeOps();
    fake.ops.openTty = () => { throw new Error("no tty canary"); };
    await expectCredentialError(
      new PosixCredentialReader(fake.ops).read("linear", { kind: "tty" }),
      "credential_input_required",
    );
    expect(fake.state.signals.size).toBe(0);
    expect(fake.state.closed).toEqual([]);
  });

  it("uses one hidden TTY session for both Slack prompts without losing read-ahead", async () => {
    const stream = Readable.from([Buffer.from("xoxb-one\nxapp-two\n")]);
    const session = new StreamTtyReadSession(42, stream);
    const fake = fakeOps();
    let sessions = 0;
    fake.ops.createTtySession = () => { sessions++; return session; };

    await expect(new PosixCredentialReader(fake.ops).read("slack", { kind: "tty" })).resolves.toEqual({
      bot_token: "xoxb-one",
      app_token: "xapp-two",
    });
    expect(sessions).toBe(1);
    expect(fake.state.writes).toEqual([
      "In the Slack app page just opened: install the app to your workspace, then find --\n",
      "  Bot token -- OAuth & Permissions -> OAuth Tokens (starts with xoxb-)\n",
      "  App token -- Basic Information -> App-Level Tokens, with the connections:write scope (starts with xapp-)\n",
      "These are secure, hidden prompts -- tokens won't be echoed to the screen.\n",
      "Press Ctrl+C to cancel.\n",
      "\n",
      "Slack bot token (xoxb-):",
      "\n",
      "Slack app token (xapp-):",
      "\n",
    ]);
    expect(fake.state.order.filter((entry) => entry === "stty:-echo")).toHaveLength(1);
    expect(fake.state.order.filter((entry) => entry === "stty:opaque-mode")).toHaveLength(1);
    expect(fake.state.closed).toEqual([42]);
    expect(fake.state.signals.size).toBe(0);
  });

  it.each([
    [
      "fireflies",
      "Fireflies API token:",
      [
        "Get your Fireflies API key: https://app.fireflies.ai/settings/developer-settings\n",
        "This is a secure, hidden prompt -- your key won't be echoed to the screen.\n",
        "Press Ctrl+C to cancel.\n",
        "\n",
      ],
    ],
    [
      "linear",
      "Linear API key:",
      [
        "Get your Linear API key: https://linear.app/settings/api\n",
        "This is a secure, hidden prompt -- your key won't be echoed to the screen.\n",
        "Press Ctrl+C to cancel.\n",
        "\n",
      ],
    ],
    [
      "claude-code",
      "Claude Code setup token:",
      [
        "Install the Claude Code CLI (https://code.claude.com/docs/en/quickstart), then run\n",
        "'claude setup-token' in your terminal and paste the result below.\n",
        "This is a secure, hidden prompt -- the token won't be echoed to the screen.\n",
        "Press Ctrl+C to cancel.\n",
        "\n",
      ],
    ],
  ] as const)("uses the exact %s prompt, preceded by guidance on where to find the credential", async (provider, prompt, guidance) => {
    const fake = fakeOps({ session: new FakeTtySession([encoder.encode("secret")]) });
    await new PosixCredentialReader(fake.ops).read(provider, { kind: "tty" });
    expect(fake.state.writes).toEqual([...guidance, prompt, "\n"]);
  });

  it("restores the full opaque mode, falls back to echo, removes handlers, and closes once", async () => {
    const fake = fakeOps({
      session: new FakeTtySession([new Uint8Array()]),
      restoreFails: true,
    });
    await expectCredentialError(
      new PosixCredentialReader(fake.ops).read("linear", { kind: "tty" }),
      "invalid_credential_input",
    );
    expect(fake.state.order).toContain("stty:opaque-mode");
    expect(fake.state.order).toContain("stty:echo");
    expect(fake.state.order.filter((entry) => entry === "close:42")).toHaveLength(1);
    expect(fake.state.signals.size).toBe(0);
    expect(fake.state.session.closeCalls).toBe(1);
  });

  it.each([
    ["mode capture", { captureFails: true }],
    ["echo disable", { hideFails: true }],
  ] as const)("does not alter terminal settings after failed %s", async (_label, options) => {
    const fake = fakeOps(options);
    await expectCredentialError(
      new PosixCredentialReader(fake.ops).read("linear", { kind: "tty" }),
      "credential_input_required",
    );
    expect(fake.state.order).not.toContain("stty:opaque-mode");
    expect(fake.state.order).not.toContain("stty:untrusted-mode");
    expect(fake.state.order).not.toContain("stty:echo");
    expect(fake.state.signals.size).toBe(0);
    expect(fake.state.closed).toEqual([42]);
  });

  it("restores and finishes descriptor cleanup when session close throws", async () => {
    const session = new FakeTtySession([encoder.encode("secret")]);
    session.closeImpl = async () => { throw new Error("close canary"); };
    const fake = fakeOps({ session });

    await expect(new PosixCredentialReader(fake.ops).read("linear", { kind: "tty" })).resolves.toEqual({
      api_key: "secret",
    });
    expect(fake.state.order.indexOf("stty:opaque-mode")).toBeLessThan(fake.state.order.indexOf("close:42"));
    expect(fake.state.signals.size).toBe(0);
    expect(fake.state.closed).toEqual([42]);
  });

  it("restores before delayed close and returns an interruption received during cleanup", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const session = new FakeTtySession([encoder.encode("secret")]);
    session.closeImpl = () => closeGate;
    const fake = fakeOps({ session });
    const pending = new PosixCredentialReader(fake.ops).read("linear", { kind: "tty" });

    for (let attempt = 0; attempt < 20 && session.closeCalls === 0; attempt++) await Bun.sleep(1);
    expect(session.closeCalls).toBe(1);
    expect(fake.state.order).toContain("stty:opaque-mode");
    fake.state.signals.get("SIGTERM")?.();
    releaseClose();

    await expectCredentialError(pending, "interrupted");
    expect(fake.state.signals.size).toBe(0);
    expect(fake.state.closed).toEqual([42]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "cancels the pending read and restores before returning %s interruption, skipping the close that would hang on it",
    async (signal) => {
      const session = new FakeTtySession([], true);
      const fake = fakeOps({ session });
      const pending = new PosixCredentialReader(fake.ops).read("linear", { kind: "tty" });
      for (let attempt = 0; attempt < 20 && session.readCalls === 0; attempt++) await Bun.sleep(1);
      expect(session.readCalls).toBe(1);
      fake.state.signals.get(signal)?.();

      await expectCredentialError(pending, "interrupted");
      expect(session.cancelCalls).toBeGreaterThanOrEqual(1);
      // A read that was genuinely in flight when the signal arrived can't be
      // cancelled (a native read on a TTY fd only settles once more input
      // arrives) -- session.close() would wait on that same read, so it's
      // skipped here. Force-exiting the process (so the abandoned read can't
      // hang it) is the caller's responsibility, after it's had a chance to
      // print/emit its own interrupted message -- see each provider's own
      // exitProcess wiring, not tested here.
      expect(session.closeCalls).toBe(0);
      expect(fake.state.order.indexOf("stty:opaque-mode")).toBeLessThan(fake.state.order.indexOf("close:42"));
      expect(fake.state.order.filter((entry) => entry === "close:42")).toHaveLength(1);
      expect(fake.state.signals.size).toBe(0);
      await Bun.sleep(0);
    },
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "settles a real child-process blocking read after %s without hanging",
    async (signal) => {
      const child = Bun.spawn({
        cmd: ["bun", join(import.meta.dir, "fixtures", "integration-credential-signal-child.ts")],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const readyReader = child.stderr.getReader();
      const ready = await Promise.race([
        readyReader.read(),
        Bun.sleep(2_000).then(() => ({ done: true, value: undefined })),
      ]);
      readyReader.releaseLock();
      expect(ready.done).toBe(false);
      expect(new TextDecoder().decode(ready.value)).toContain("READY");

      child.kill(signal);
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(2_000).then(() => -999),
      ]);
      if (exitCode === -999) child.kill("SIGKILL");
      expect(exitCode).toBe(0);
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ code: "interrupted" });
    },
  );
});

describe("default browser launcher", () => {
  it.each([
    ["darwin", "/usr/bin/open"],
    ["linux", "/usr/bin/xdg-open"],
  ] as const)("uses one argv-only %s launcher", async (platform, executable) => {
    const calls: string[][] = [];
    process.env.BROWSER = "raw-browser-canary --with-shell";
    const launcher = new PosixBrowserLauncher({
      platform,
      spawn: async (argv) => { calls.push(argv); return 0; },
    });
    const url = "https://github.com/apps/draft/installations/new?state=safe-state";
    await expect(launcher.launchBrowser(url)).resolves.toEqual({ opened: true });
    expect(calls).toEqual([[executable, url]]);
    expect(JSON.stringify(calls)).not.toContain("raw-browser-canary");
    delete process.env.BROWSER;
  });

  it("allows only https/file URLs and rejects unsupported platforms before spawn", async () => {
    const calls: string[][] = [];
    const launcher = new PosixBrowserLauncher({
      platform: "win32",
      spawn: async (argv) => { calls.push(argv); return 0; },
    });
    for (const url of ["http://example.com", "javascript:alert(1)", "not-a-url", "ftp://example.com/file"]) {
      await expect(launcher.launchBrowser(url)).resolves.toEqual({ opened: false });
    }
    await expect(launcher.launchBrowser("https://github.com/apps/test")).resolves.toEqual({ opened: false });
    expect(calls).toEqual([]);

    const fileCalls: string[][] = [];
    const fileLauncher = new PosixBrowserLauncher({
      platform: "darwin",
      spawn: async (argv) => { fileCalls.push(argv); return 0; },
    });
    await expect(fileLauncher.launchBrowser("file:///tmp/handoff.html")).resolves.toEqual({ opened: true });
    expect(fileCalls[0]).toEqual(["/usr/bin/open", "file:///tmp/handoff.html"]);
  });

  it("returns false for nonzero exits and spawn failures", async () => {
    await expect(new PosixBrowserLauncher({
      platform: "linux",
      spawn: async () => 1,
    }).launchBrowser("https://api.slack.com/apps")).resolves.toEqual({ opened: false });
    await expect(new PosixBrowserLauncher({
      platform: "darwin",
      spawn: async () => { throw new Error("raw-spawn-canary"); },
    }).launchBrowser("https://github.com/apps/test")).resolves.toEqual({ opened: false });
  });
});
