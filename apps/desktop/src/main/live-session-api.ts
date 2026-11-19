import type { ApprovalResponse, SessionViewQuery, SessionViewResponse, LiveSession, LiveSessionEventsPage, LiveSessionInput } from "draft-core/live-sessions";
import { hostServices, ServerError } from "draft-core/host/services";
import { sessionBase, type StartLiveSessionResult } from "draft-core/host/live-session";
import { listSnapshotEnvFiles, snapshotFolderSize, nodeSnapshotFs, putArchive, uploadSnapshot, type SnapshotExec, type SnapshotFs, type PutArchive, type SnapshotUploadResult } from "./snapshot";
import { capture } from "../exec";

export type LocalStartParams = { runtime?: "local"; harness?: string; folderPath: string; model?: string | null; effort?: string | null };

/**
 * The seed a cloud session starts from: a GitHub repository, a folder snapshot already uploaded under `sessionId`,
 * or the finished routine run (`sessionId`) that a new chat continues.
 */
export type CloudSeedParams =
  | { kind: "repo"; gitRemote: string; branch: string }
  | { kind: "snapshot"; sessionId: string; storageKey: string; folderName: string }
  | { kind: "routine_run"; sessionId: string }
  | { kind: "empty" };

export type CloudStartParams = { runtime: "cloud"; model: string | null; effort: string | null; network: "restricted" | "open"; seed: CloudSeedParams };

/** The server calls a desktop makes to create a cloud session. Injected so tests can run without a signed-in host. */
export interface CloudStartDeps {
  workspaceId(): string | null;
  fetchServerJSON<T>(path: string, init?: RequestInit): Promise<T>;
}

/** What packing and uploading a folder needs beyond the server calls. */
export interface CloudSnapshotDeps extends CloudStartDeps {
  fs: SnapshotFs;
  exec: SnapshotExec;
  put: PutArchive;
}

const hostCloudStartDeps: CloudStartDeps = {
  workspaceId: () => hostServices().workspaceId(),
  fetchServerJSON: (path, init) => hostServices().fetchServerJSON(path, init),
};

const hostCloudSnapshotDeps: CloudSnapshotDeps = {
  ...hostCloudStartDeps,
  fs: nodeSnapshotFs,
  exec: (argv, options) => capture(argv, options),
  put: putArchive,
};

/**
 * Creates a cloud session on the server. Nothing runs on this computer: the cloud sandbox hosts the session.
 * The error is the server's code, or start_failed when the request never got an answer.
 */
export async function startCloudLiveSession(params: CloudStartParams, deps: CloudStartDeps = hostCloudStartDeps): Promise<StartLiveSessionResult> {
  const workspaceId = deps.workspaceId();
  if (!workspaceId) return { ok: false, error: "signed_out" };
  // A snapshot names its session in the body. The server checks that the key's session is the same one.
  const { seed } = params;
  const sessionFields = seed.kind === "snapshot" ? { sessionId: seed.sessionId } : {};
  const seedBody =
    seed.kind === "repo"
      ? { kind: "repo", gitRemote: seed.gitRemote, branch: seed.branch }
      : seed.kind === "empty"
        ? { kind: "empty" }
        : seed.kind === "routine_run"
        ? { kind: "routine_run", sessionId: seed.sessionId }
        : { kind: "snapshot", storageKey: seed.storageKey, folderName: seed.folderName };
  try {
    const body = await deps.fetchServerJSON<{ ok: true; session: { id: string } }>(`workspaces/${workspaceId}/live-sessions`, {
      method: "POST",
      body: JSON.stringify({
        runtime: "cloud",
        harness: "claude",
        model: params.model,
        reasoningEffort: params.effort,
        network: params.network,
        ...sessionFields,
        seed: seedBody,
      }),
    });
    return { ok: true, sessionId: body.session.id };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "start_failed" };
  }
}

/** The `.env*` files of a folder, for the checklist before a snapshot. Nothing is sent to the server. */
export function listLiveSessionEnvFiles(folderPath: string, fs: SnapshotFs = nodeSnapshotFs): { ok: true; files: string[] } | { ok: false; error: string } {
  return listSnapshotEnvFiles(folderPath, fs);
}

/** How much a snapshot of the folder would copy, for the size warning before Start. */
export function liveSessionSnapshotSize(folderPath: string, fs: SnapshotFs = nodeSnapshotFs) {
  return snapshotFolderSize(folderPath, fs);
}

/**
 * Packs a folder with the chosen `.env` files, uploads it under a new session id, and returns what the start call
 * needs. Nothing is uploaded when the folder is refused.
 */
export async function uploadLiveSessionSnapshot(
  params: { folderPath: string; includeEnvFiles: string[] },
  deps: CloudSnapshotDeps = hostCloudSnapshotDeps,
): Promise<SnapshotUploadResult> {
  const workspaceId = deps.workspaceId();
  if (!workspaceId) return { ok: false, error: "signed_out" };
  return uploadSnapshot(params.folderPath, params.includeEnvFiles, {
    fs: deps.fs,
    exec: deps.exec,
    put: deps.put,
    requestUpload: async () => {
      const { sessionId, storageKey, signedUrl } = await deps.fetchServerJSON<{ ok: true; sessionId: string; storageKey: string; signedUrl: string }>(
        `workspaces/${workspaceId}/live-sessions/seed-upload`,
        { method: "POST" },
      );
      return { sessionId, storageKey, signedUrl };
    },
  });
}

/**
 * Starts a session the way the request asks: a cloud one on the server, anything else as a computer session through
 * `startLocal`. A cloud request never reaches `startLocal`, so no host process starts on this computer for it.
 */
export async function startLiveSessionRequest(
  params: LocalStartParams | CloudStartParams,
  startLocal: (params: LocalStartParams) => Promise<StartLiveSessionResult>,
  deps?: CloudStartDeps,
): Promise<StartLiveSessionResult> {
  if (params.runtime === "cloud") return startCloudLiveSession(params, deps);
  return startLocal(params);
}

export async function listLiveSessions(): Promise<LiveSession[]> {
  const workspaceId = hostServices().workspaceId();
  if (!workspaceId) return [];
  const body = await hostServices().fetchServerJSON<{ sessions: LiveSession[] }>(`workspaces/${workspaceId}/live-sessions`);
  return body.sessions;
}

export async function getLiveSessionEvents(sessionId: string, after: number): Promise<LiveSessionEventsPage> {
  return hostServices().fetchServerJSON<LiveSessionEventsPage>(`${sessionBase(sessionId)}/events?after=${after}`);
}

export async function sendLiveSessionMessage(sessionId: string, text: string): Promise<{ ok: true; input?: LiveSessionInput } | { ok: false; error: string }> {
  try {
    const body = await hostServices().fetchServerJSON<{ input?: LiveSessionInput }>(`${sessionBase(sessionId)}/inputs`, { method: "POST", body: JSON.stringify({ text }) });
    return { ok: true, input: body.input };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "send_failed" };
  }
}

export async function actOnLiveSessionInput(sessionId: string, inputId: string, action: "resend" | "dismiss" | "steer" | "cancel"): Promise<void> {
  await hostServices().fetchServer(`${sessionBase(sessionId)}/inputs/${inputId}`, { method: "POST", body: JSON.stringify({ action }) });
}

/** Sends a teammate's decision on an open permission request. */
export async function decideLiveSessionApproval(
  sessionId: string,
  requestId: string,
  response: ApprovalResponse,
): Promise<{ ok: true } | { ok: false; error: string; byName?: string | null; reason?: string | null }> {
  try {
    await hostServices().fetchServer(`${sessionBase(sessionId)}/approvals/${encodeURIComponent(requestId)}/decision`, { method: "POST", body: JSON.stringify(response) });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ServerError)) return { ok: false, error: "decision_failed" };
    const detail = (error.detail ?? {}) as { by_name?: string | null; reason?: string | null };
    return { ok: false, error: error.code, byName: detail.by_name ?? null, reason: detail.reason ?? null };
  }
}

export async function setLiveSessionMode(sessionId: string, change: { permissionMode?: string; approvalMode?: string; model?: string | null; reasoningEffort?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await hostServices().fetchServer(`${sessionBase(sessionId)}/mode`, { method: "POST", body: JSON.stringify(change) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "mode_failed" };
  }
}

export async function stopLiveSession(sessionId: string, keepQueued = false): Promise<{ ok: true; withdrawn: string[] } | { ok: false; error: string }> {
  try {
    const response = await hostServices().fetchServer(`${sessionBase(sessionId)}/stop`, { method: "POST", body: JSON.stringify(keepQueued ? { keepQueued: true } : {}) });
    const body = (await response.json().catch(() => ({}))) as { withdrawn?: Array<{ text: string }> };
    return { ok: true, withdrawn: (body.withdrawn ?? []).map((input) => input.text) };
  } catch (error) {
    return { ok: false, error: error instanceof ServerError ? error.code : "stop_failed" };
  }
}

export async function getLiveSessionView(sessionId: string, query: SessionViewQuery): Promise<SessionViewResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return hostServices().fetchServerJSON<SessionViewResponse>(`${sessionBase(sessionId)}/view?${params}`);
}
