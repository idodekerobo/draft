export type IntegrationActivitySource = 'granola' | 'fireflies' | 'slack';

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
