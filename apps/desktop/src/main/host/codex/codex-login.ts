import { GUI_PATH, capture } from "../../../exec";
import { findRunnerBin } from "../find-bin";
import { readCodexAuth, readCodexVersion, type CodexAuth } from "./codex-check";

export interface CodexStatus {
  installed: boolean;
  auth: CodexAuth;
  version: string | null;
}

export type CodexLoginStart = { ok: true; deviceUrl?: string; deviceCode?: string } | { ok: false; error: string };

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const DEVICE_START_WAIT_MS = 15_000;

/** The sign-in link and one-time code in the output of `codex login --device-auth`. */
export function parseDeviceAuth(output: string): { url: string; code: string } | null {
  const text = output.replace(ANSI, "");
  const url = /(https:\/\/\S+\/codex\/device)\b/.exec(text)?.[1];
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{3,}-[A-Z0-9]{3,})/i.exec(text)?.[1];
  return url && code ? { url, code } : null;
}

let login: { proc: ReturnType<typeof Bun.spawn> } | null = null;

export async function getCodexStatus(): Promise<CodexStatus> {
  const bin = findRunnerBin("codex");
  if (!bin) return { installed: false, auth: "unknown", version: null };
  const [auth, version] = await Promise.all([readCodexAuth(bin), readCodexVersion(bin)]);
  return { installed: true, auth, version };
}

/**
 * Runs `codex login`, which opens the browser, or `codex login --device-auth` for a link and a code.
 * Codex clears the stored login when a flow starts, so a flow that is cancelled leaves the person signed out.
 * The caller polls `getCodexStatus` until the login shows. With `codexHome` the login is made in that folder
 * and the person's own login is not touched.
 */
export async function startCodexLogin(options: { deviceCode: boolean }, codexHome?: string): Promise<CodexLoginStart> {
  const bin = findRunnerBin("codex");
  if (!bin) return { ok: false, error: "Codex is not installed on this computer." };
  cancelCodexLogin();

  const proc = Bun.spawn([bin, "login", ...(options.deviceCode ? ["--device-auth"] : [])], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: GUI_PATH, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
  });
  const current = { proc };
  login = current;
  void proc.exited.then(() => {
    if (login === current) login = null;
  });
  const output = collectOutput(proc);
  if (!options.deviceCode) return { ok: true };

  const deadline = Date.now() + DEVICE_START_WAIT_MS;
  while (Date.now() < deadline) {
    const found = parseDeviceAuth(output());
    if (found) return { ok: true, deviceUrl: found.url, deviceCode: found.code };
    await Bun.sleep(150);
  }
  cancelCodexLogin();
  return { ok: false, error: "Codex did not give a sign-in code. Try again, or run codex login in a terminal." };
}

/** Reads the process output as it comes, so the pipes never fill and block it. */
function collectOutput(proc: ReturnType<typeof Bun.spawn>): () => string {
  const decoder = new TextDecoder();
  let text = "";
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!(stream instanceof ReadableStream)) continue;
    const reader = stream.getReader();
    void (async () => {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value, { stream: true });
    })().catch(() => {});
  }
  return () => text;
}

export function cancelCodexLogin(): void {
  login?.proc.kill();
  login = null;
}

export async function codexLogout(): Promise<{ ok: true } | { ok: false; error: string }> {
  const bin = findRunnerBin("codex");
  if (!bin) return { ok: false, error: "Codex is not installed on this computer." };
  cancelCodexLogin();
  try {
    const result = await capture([bin, "logout"], { timeoutMs: 10_000 });
    return result.exitCode === 0 ? { ok: true } : { ok: false, error: "Could not sign out of Codex." };
  } catch {
    return { ok: false, error: "Could not sign out of Codex." };
  }
}
