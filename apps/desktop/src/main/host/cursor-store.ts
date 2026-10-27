import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

export interface FileCursor {
  offset: number;
  /** Hash of the bytes just before `offset`, to notice a replaced file. */
  fingerprint: string;
  /** Recent native uuids already posted. */
  seenIds: string[];
}

export interface RawUploadRecord {
  size: number;
  mtimeMs: number;
}

export interface HostSessionState {
  sessionId: string;
  workspaceId: string;
  hostMachineId: string;
  nativeSessionId: string;
  folderPath: string;
  tmuxSession: string;
  cursors: Record<string, FileCursor>;
  rawUploads: Record<string, RawUploadRecord>;
  /** The pane is gone and the session was ended; only a raw upload may remain. */
  ended: boolean;
}

const SESSIONS_DIR = `${process.env.HOME}/.draft/host/sessions`;

export function saveState(state: HostSessionState, dir = SESSIONS_DIR): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${state.sessionId}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

export function loadStates(dir = SESSIONS_DIR): HostSessionState[] {
  if (!existsSync(dir)) return [];
  const states: HostSessionState[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      states.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as HostSessionState);
    } catch {
      console.error("[live-session] skipping unreadable state file", name);
    }
  }
  return states;
}

export function deleteState(sessionId: string, dir = SESSIONS_DIR): void {
  rmSync(join(dir, `${sessionId}.json`), { force: true });
}
