import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Pool } from "pg";
import { CredentialError } from "../../credentials/crypto";
import { loadConfig } from "../../config";
import { serviceClient } from "../../db/client";
import { recordError } from "../../errors/record-error";
import { createPiAgentFactory } from "../../embedded-agent/pi/adapter";
import { loadSandboxDeploymentConfig } from "../../metaharness/sandbox/config";
import { providerFor } from "../../metaharness/sandbox/providers";
import { createDraftToolRegistry } from "../../metaharness/tools/definitions";
import { userInvokeDeps } from "../../metaharness/tools/user-gateway";
import { reportCredentialFailure } from "../../notify/product/credential-attention";
import { HomeComputer, pgBindingStore } from "../computer/computer";
import { idleComputerSessions, sweepComputers } from "../computer/lifecycle";
import { createComputerTools } from "../computer/tools";
import { homeModels } from "../models";
import { homePrompt } from "../prompt";
import { createHomeTools } from "../tools";
import { HomeHost } from "./host";
import { projectOutbox } from "./project";
import { openHomeRun, settleHomeRun } from "./runs";
import { createHostStore } from "./store";
import { DEFAULT_HOME_MODEL, HOME_ADAPTER_ID } from "./spec";
import { setHomeWaker } from "./wake";
import { createSupabaseWakeBus } from "./wake-bus";

let host: HomeHost | undefined;
let pool: Pool | undefined;
let computerSweep: ReturnType<typeof setInterval> | undefined;

const COMPUTER_SWEEP_MS = 60_000;

/** Starts Home's agents in this process. Does nothing when the database connection is not configured. */
export function startHome(): HomeHost | undefined {
  if (host) return host;
  const config = loadConfig();
  if (!config.betterAuthDatabaseUrl) {
    console.warn("Home is off: BETTER_AUTH_DATABASE_URL is not set");
    return undefined;
  }
  // A pool of its own, on the public schema: the sign-in pool puts another schema first.
  pool = new Pool({ connectionString: config.betterAuthDatabaseUrl, max: 8 });
  const registry = createDraftToolRegistry(serviceClient);
  const invoke = userInvokeDeps(serviceClient, registry);
  // Home's computer is a sandbox machine. Without sandbox settings Home still runs, with no computer tools.
  let sandbox: ReturnType<typeof providerFor> | undefined;
  try {
    sandbox = providerFor(loadSandboxDeploymentConfig().provider);
  } catch (error) {
    console.warn(`Home has no computer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const computerFor = (sessionId: string, stillOwner: () => Promise<boolean>) =>
    new HomeComputer({ provider: sandbox!, store: pgBindingStore(pool!, sessionId), sessionId, stillOwner });
  const factory = createPiAgentFactory((context) => ({
    pool: pool!,
    models: homeModels(serviceClient, context.workspaceId),
    defaultModel: { provider: "anthropic", model: DEFAULT_HOME_MODEL },
    tools: (toolContext, gate, lifecycle) => {
      const draft = createHomeTools({ tools: registry.listForUser(), invoke, context: toolContext, gate });
      if (!sandbox) return draft;
      const computer = computerFor(toolContext.sessionId, toolContext.stillOwner);
      return [...draft, ...createComputerTools({ computer: () => computer, context: toolContext, lifecycle })];
    },
    onReport: (error) => {
      // pi wraps a login that cannot be read as an auth error. The login's owner is told once per failure.
      const cause = error instanceof CredentialError ? error : (error as { cause?: unknown } | null)?.cause;
      if (cause instanceof CredentialError) void reportCredentialFailure(serviceClient, context.workspaceId, cause);
    },
  }));
  host = new HomeHost({
    store: createHostStore({ pool, client: serviceClient }),
    bus: createSupabaseWakeBus(serviceClient),
    runs: {
      open: (session, instructions) => openHomeRun(serviceClient, session, instructions),
      settle: (sessionId, runId) => settleHomeRun(serviceClient, sessionId, runId),
    },
    factory,
    project: async (session) => {
      const settled: Array<{ requestId: string; outcome: string }> = [];
      await projectOutbox({ pool: pool!, client: serviceClient, adapterId: HOME_ADAPTER_ID, onSettled: (rows) => void settled.push(...rows) }, { id: session.id, workspaceId: session.workspaceId });
      return settled;
    },
    owner: `home:${hostname()}:${randomUUID()}`,
    instructions: () => homePrompt(),
    onError: (error, where) => {
      void recordError({ workspaceId: null, operation: "session", code: "home_host_error", message: `Home host failed at ${where}`, error });
    },
  });
  host.start();
  if (sandbox) {
    // The claim check is not needed here: stopping an idle machine or removing an expired one is safe from any process.
    computerSweep = setInterval(() => {
      void sweepComputers({
        sessions: () => idleComputerSessions(pool!),
        computerFor: (sessionId) => computerFor(sessionId, async () => true),
        onError: (error, sessionId) => void recordError({ workspaceId: null, sessionId, operation: "execution", code: "home_computer_sweep_failed", message: "Stopping or removing Home's idle computer failed", error }),
      });
    }, COMPUTER_SWEEP_MS);
  }
  setHomeWaker((sessionId) => host!.wake(sessionId));
  return host;
}

/** Drains Home before the process exits: stops taking work, closes the agents and gives up their claims. */
export async function stopHome(): Promise<void> {
  setHomeWaker(undefined);
  if (computerSweep) clearInterval(computerSweep);
  await host?.stop();
  await pool?.end();
  host = undefined;
  pool = undefined;
}
