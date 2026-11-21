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
  hostId: string;
  nativeSessionId: string;
  folderPath: string;
  /** Which harness runs the session. Files from before Codex have none and mean Claude. */
  harness?: string;
  /** Claude only. */
  tmuxSession?: string;
  cursors: Record<string, FileCursor>;
  rawUploads: Record<string, RawUploadRecord>;
  /** The pane is gone and the session was ended; only a raw upload may remain. */
  ended: boolean;
  /** Hook calls from the pane carry this id; it stays the first session's id after a /clear. */
  hookId?: string;
  model?: string | null;
  /** Plain text such as "low"; null or missing means the harness's own setting. */
  reasoningEffort?: string | null;
  harnessVersion?: string | null;
  resumeRequestId?: string;
  /** Permission requests posted and not yet closed, so a restart can close them. */
  openRequests?: string[];
}

/** Dev builds use another folder so they never resume the installed app's sessions, or the reverse. */
export function hostSessionsDir(home = process.env.HOME, dev = process.env.DRAFT_DESKTOP_DEV === "1"): string {
  return `${home}/.draft/${dev ? "host-dev" : "host"}/sessions`;
}

export function saveState(state: HostSessionState, dir = hostSessionsDir()): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${state.sessionId}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

export function loadStates(dir = hostSessionsDir()): HostSessionState[] {
  if (!existsSync(dir)) return [];
  const states: HostSessionState[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      // Files saved before the rename carry hostMachineId.
      const { hostMachineId, ...saved } = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<HostSessionState> & { hostMachineId?: string };
      states.push({ ...saved, hostId: saved.hostId ?? hostMachineId } as HostSessionState);
    } catch {
      console.error("[live-session] skipping unreadable state file", name);
    }
  }
  return states;
}

export function deleteState(sessionId: string, dir = hostSessionsDir()): void {
  rmSync(join(dir, `${sessionId}.json`), { force: true });
}

export function saveRetiredState(state: HostSessionState, id: string, dir = `${hostSessionsDir()}/retired`): void {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${id}.json`;
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

export function loadRetiredStates(dir = `${hostSessionsDir()}/retired`): Array<{ id: string; state: HostSessionState }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(".json")).flatMap(name => {
    try { return [{ id: name.slice(0, -5), state: JSON.parse(readFileSync(join(dir, name), "utf8")) as HostSessionState }]; }
    catch { return []; }
  });
}

export function deleteRetiredState(id: string, dir = `${hostSessionsDir()}/retired`): void {
  deleteState(id, dir);
}
