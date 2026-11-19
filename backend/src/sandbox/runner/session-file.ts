import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { SessionFileSide } from "draft-core/harnesses/types";
import type { RunnerManifest } from "draft-core/run-manifest";
import { runnerLog, sanitizeReason } from "./log";

/** A session file bigger than this is not kept: the cap keeps one run from filling storage. */
export const SESSION_FILE_MAX_BYTES = 50 * 1024 * 1024;
const SEARCH_DEPTH = 4;
const UPLOAD_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 5_000;
const AGENT_HOME = "/home/agent";
const AGENT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// A native session id goes into a file path, so only plain id characters pass.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type SessionUpload = NonNullable<RunnerManifest["sessionUpload"]>;
export type PutObject = (url: string, body: Uint8Array, contentType: string) => Promise<void>;

/** The session file of one native session, searched for a few folders down from `root`. Null when there is none. */
export function findSessionFile(root: string, side: SessionFileSide, nativeSessionId: string, depth = SEARCH_DEPTH): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const file = entries.find((entry) => entry.isFile() && side.isSessionFile(entry.name, nativeSessionId));
  if (file) return join(root, file.name);
  if (depth <= 1) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findSessionFile(join(root, entry.name), side, nativeSessionId, depth - 1);
    if (found) return found;
  }
  return null;
}

/** The first version number in a CLI's `--version` output, or null. The command runs as the agent user, with no environment of ours. */
export function readCliVersion(argv: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gosu", ["agent", "env", "-i", `HOME=${AGENT_HOME}`, `PATH=${AGENT_PATH}`, ...argv], { timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(/\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null);
    });
  });
}

async function putToStorage(url: string, body: Uint8Array, contentType: string): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType, "x-upsert": "true" },
    body: Buffer.from(body),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`session upload returned HTTP ${response.status}`);
}

export interface KeepSessionFileInput {
  runId: string;
  harness: RunnerManifest["harness"];
  side: SessionFileSide;
  nativeSessionId: string | null;
  upload: SessionUpload;
  /** Where the harness keeps its session files. The run's own home, unless a test names another folder. */
  root?: string;
  put?: PutObject;
  cliVersion?: () => Promise<string | null>;
  maxBytes?: number;
}

/**
 * Gzips the harness's session file and PUTs it to its signed link, with a small metadata file beside it. Best-effort:
 * the run's result never waits on it. Returns true only when the session file reached storage.
 */
export async function keepSessionFile(input: KeepSessionFileInput): Promise<boolean> {
  const { runId, harness, side, nativeSessionId, upload } = input;
  const put = input.put ?? putToStorage;
  const maxBytes = input.maxBytes ?? SESSION_FILE_MAX_BYTES;
  try {
    if (nativeSessionId === null || !SAFE_SESSION_ID.test(nativeSessionId)) {
      runnerLog("session_file_skipped", { run_id: runId, reason: "no_native_session" });
      return false;
    }
    const path = findSessionFile(input.root ?? side.root, side, nativeSessionId);
    if (!path) {
      runnerLog("session_file_skipped", { run_id: runId, reason: "file_missing" });
      return false;
    }
    const bytes = statSync(path).size;
    if (bytes > maxBytes) {
      runnerLog("session_file_skipped", { run_id: runId, reason: "too_large", bytes, max_bytes: maxBytes });
      return false;
    }
    const gzipped = gzipSync(readFileSync(path));
    try {
      await put(upload.fileUrl, gzipped, "application/gzip");
    } catch (error) {
      runnerLog("session_file_upload_failed", { run_id: runId, reason: sanitizeReason(error) });
      return false;
    }
    runnerLog("session_file_uploaded", { run_id: runId, bytes, stored_bytes: gzipped.byteLength });

    const metadata = {
      harness,
      cli_version: await (input.cliVersion ?? (() => readCliVersion(side.versionCommand)))().catch(() => null),
      cwd: side.workingDir,
      native_session_id: nativeSessionId,
      run_id: runId,
      bytes,
    };
    try {
      await put(upload.metadataUrl, new TextEncoder().encode(`${JSON.stringify(metadata)}\n`), "application/json");
    } catch (error) {
      runnerLog("session_metadata_upload_failed", { run_id: runId, reason: sanitizeReason(error) });
    }
    return true;
  } catch (error) {
    runnerLog("session_file_failed", { run_id: runId, reason: sanitizeReason(error) });
    return false;
  }
}
