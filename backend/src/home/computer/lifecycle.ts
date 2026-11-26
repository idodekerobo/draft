import type { Pool } from "pg";
import type { HomeComputer } from "./computer";

export const IDLE_STOP_MS = 15 * 60_000;
/** Files on a Home's computer expire after this long unused. The transcript is not touched. */
export const FILE_EXPIRY_MS = 14 * 24 * 60 * 60_000;

/** Sessions that have a computer and no open run: the ones whose machine may be stopped or removed. */
export async function idleComputerSessions(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(
    `select s.session_id from embedded_agent_state s
      where s.kind = 'computer' and s.key = 'binding'
        and not exists (select 1 from agent_runs r where r.session_id = s.session_id and r.status in ('queued', 'preparing', 'running', 'validating', 'committing'))`,
  );
  return rows.map((row) => row.session_id as string);
}

/**
 * Stops machines that have been idle and removes the ones whose files expired. A machine with a run open is left alone, and a
 * failure on one machine does not stop the sweep of the others.
 */
export async function sweepComputers(deps: { sessions: () => Promise<string[]>; computerFor: (sessionId: string) => HomeComputer; onError?: (error: unknown, sessionId: string) => void }): Promise<{ stopped: number; expired: number }> {
  let stopped = 0;
  let expired = 0;
  for (const sessionId of await deps.sessions()) {
    try {
      const computer = deps.computerFor(sessionId);
      if (await computer.expireIfOld(FILE_EXPIRY_MS)) expired++;
      else if (await computer.stopIfIdle(IDLE_STOP_MS)) stopped++;
    } catch (error) {
      deps.onError?.(error, sessionId);
    }
  }
  return { stopped, expired };
}
