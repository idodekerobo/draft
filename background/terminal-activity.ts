import { mkdirSync } from 'fs';
import { openActivityDb, insertRun, type ActivityRun } from 'draft-core/db/activity';
import { sanitizeMcpMessage } from 'draft-core/integrations/mcp-health';

export type IntegrationActivitySource = 'granola' | 'fireflies' | 'slack';
export type TerminalMaintainerOutcome = Exclude<ActivityRun['maintainerOutcome'], null>;

export interface TerminalActivity {
  id: string;
  timestamp: string;
  startedAt: string;
  startedMs: number;
}

export function startTerminalActivity(
  source: IntegrationActivitySource,
  now: Date,
): TerminalActivity {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    id: `${source}:${timestamp}`,
    timestamp,
    startedAt: timestamp,
    startedMs: now.getTime(),
  };
}

export function recordTerminalActivity(input: {
  workspace: string;
  profile: string;
  source: IntegrationActivitySource;
  activity: TerminalActivity;
  endedAt: Date;
  outcome?: TerminalMaintainerOutcome;
  error?: unknown;
  log?: (level: 'warn', message: string) => void;
}): void {
  const failed = input.error !== undefined;
  const errorMsg = failed
    ? sanitizeMcpMessage(input.error instanceof Error ? input.error.message : String(input.error))
    : null;
  let db: ReturnType<typeof openActivityDb> | undefined;

  try {
    mkdirSync(input.workspace, { recursive: true });
    db = openActivityDb(input.workspace);
    insertRun(db, {
      id: input.activity.id,
      profile: input.profile,
      source: input.source,
      sessionId: null,
      cwd: null,
      transcriptPath: null,
      startedAt: input.activity.startedAt,
      endedAt: input.endedAt.toISOString(),
      status: failed ? 'failed' : 'success',
      durationMs: Math.max(0, input.endedAt.getTime() - input.activity.startedMs),
      proposalsGenerated: input.outcome === 'needs_input' ? 1 : 0,
      maintainerOutcome: failed ? null : input.outcome ?? null,
      skipReason: null,
      errorMsg,
    });
  } catch (error) {
    input.log?.('warn', `failed to write activity row: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { db?.close(); } catch {}
  }
}
