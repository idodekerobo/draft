// The session host of a cloud session. It runs in a sandbox on Bun, drives the harness, and sleeps the session when idle.
import { DEFAULT_HARNESS_ID, isHarnessId, type HarnessId } from "draft-core/harnesses";
import { registrationFor } from "draft-core/host/drivers/drivers";
import { loadStates, type HostSessionState } from "draft-core/host/cursor-store";
import { attachLiveSession, type AttachedSession } from "draft-core/host/live-session";
import { installHostServices, type HostServices } from "draft-core/host/services";
import type { LiveSession, LiveSessionEventsPage } from "draft-core/live-sessions";
import { buildHostServices } from "./host/cloud-services";
import { cloudHostId, parseHostConfig, seedSecrets, type HostConfig } from "./host/config";
import { canSleep } from "./host/idle";
import { hostLog, messageOf, setRedactions } from "./host/log";
import { liveSeedDeps, prepareWorkspace } from "./host/seed";

/** The workspace on the sandbox volume. HOME is on the same volume, so a sleeping session keeps its conversation. */
const WORKSPACE_PATH = "/data/workspace";
const LOOP_MS = 2_000;

type SessionRow = LiveSession & { native_session_id?: string | null };
type Outcome = "idle" | "terminated" | "ended";

/** Runs the host until it sleeps, ends or is stopped. Returns the process exit code. */
export async function runHost(env: Record<string, string | undefined>): Promise<number> {
  let terminating = false;
  process.on("SIGTERM", () => {
    terminating = true;
  });

  let config: HostConfig;
  try {
    config = parseHostConfig(env);
  } catch (error) {
    hostLog("error", "config_invalid", { reason: messageOf(error) });
    return 2;
  }
  setRedactions([config.runToken, ...seedSecrets(config.seed)]);
  const services = buildHostServices(config);
  installHostServices(services);
  const hostId = cloudHostId(config.sessionId);
  const base = `workspaces/${config.workspaceId}/live-sessions/${config.sessionId}`;

  let row: SessionRow;
  try {
    row = (await services.fetchServerJSON<LiveSessionEventsPage>(`${base}/events?after=0&limit=1`)).session;
  } catch (error) {
    hostLog("error", "session_load_failed", { reason: messageOf(error) });
    await endSession(services, base, hostId, "host_failed");
    return 1;
  }
  if (row.status === "ended") {
    hostLog("info", "session_already_ended", { endReason: row.end_reason ?? null });
    return 0;
  }

  const harness = row.harness ?? DEFAULT_HARNESS_ID;
  if (!isHarnessId(harness)) {
    hostLog("error", "harness_unsupported", { harness });
    await endSession(services, base, hostId, "launch_failed");
    return 1;
  }

  try {
    const prepared = await prepareWorkspace(config.seed, WORKSPACE_PATH, liveSeedDeps());
    hostLog("info", "workspace_ready", { path: WORKSPACE_PATH, seeded: prepared === "prepared" });
  } catch (error) {
    hostLog("error", "seed_failed", { reason: messageOf(error) });
    await endSession(services, base, hostId, "seed_failed");
    return 1;
  }

  const saved = loadStates().find((state) => state.sessionId === config.sessionId && !state.ended);
  const mode: "resume" | "launch" = saved ? "resume" : "launch";
  let attached: Awaited<ReturnType<typeof attachLiveSession>>;
  try {
    attached = await attachLiveSession(saved ?? freshState(config, row, harness), mode);
  } catch (error) {
    hostLog("error", "attach_failed", { mode, reason: messageOf(error) });
    await endSession(services, base, hostId, mode === "resume" ? "resume_failed" : "launch_failed");
    return 1;
  }
  if (!attached.ok) {
    hostLog("error", "attach_refused", { mode, reason: attached.error });
    await endSession(services, base, hostId, mode === "resume" ? "resume_failed" : "launch_failed");
    return 1;
  }
  hostLog("info", "session_attached", { mode, harness });

  let outcome: Outcome;
  try {
    outcome = await waitForOutcome(attached.session, () => terminating);
  } catch (error) {
    hostLog("error", "host_loop_failed", { reason: messageOf(error) });
    await endSession(services, base, hostId, "host_failed");
    return 1;
  }
  if (outcome === "ended") {
    hostLog("info", "session_stopped");
    return 0;
  }

  let flushed: boolean;
  try {
    flushed = await attached.session.retire();
    if (!flushed) hostLog("error", "flush_incomplete");
  } catch (error) {
    flushed = false;
    hostLog("error", "flush_failed", { reason: messageOf(error) });
  }
  await requestSleep(services, base, hostId, outcome);
  return flushed ? 0 : 1;
}

/** A session that has never run here starts from its server row. */
function freshState(config: HostConfig, row: SessionRow, harness: HarnessId): HostSessionState {
  return {
    sessionId: config.sessionId,
    workspaceId: config.workspaceId,
    hostId: cloudHostId(config.sessionId),
    nativeSessionId: row.native_session_id || registrationFor(harness).launcher.newNativeSessionId(),
    folderPath: WORKSPACE_PATH,
    harness,
    cursors: {},
    rawUploads: {},
    ended: false,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
  };
}

async function waitForOutcome(session: AttachedSession, terminating: () => boolean): Promise<Outcome> {
  for (;;) {
    if (session.hasEnded()) return "ended";
    if (terminating()) return "terminated";
    const activity = await session.activity();
    if (canSleep({ now: Date.now(), ...activity })) return "idle";
    await sleep(LOOP_MS);
  }
}

async function requestSleep(services: HostServices, base: string, hostId: string, outcome: Outcome): Promise<void> {
  try {
    await services.fetchServer(`${base}/host/sleep`, { method: "POST", body: JSON.stringify({ hostId }) });
    hostLog("info", "session_sleeping", { outcome });
  } catch (error) {
    hostLog("error", "sleep_failed", { reason: messageOf(error) });
  }
}

async function endSession(services: HostServices, base: string, hostId: string, reason: string): Promise<void> {
  try {
    await services.fetchServer(`${base}/end`, { method: "POST", body: JSON.stringify({ hostId, reason }) });
  } catch (error) {
    hostLog("error", "end_failed", { requestedReason: reason, reason: messageOf(error) });
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

if (import.meta.main) {
  runHost(process.env).then(
    (code) => process.exit(code),
    (error) => {
      hostLog("error", "host_crashed", { reason: messageOf(error) });
      process.exit(1);
    },
  );
}
