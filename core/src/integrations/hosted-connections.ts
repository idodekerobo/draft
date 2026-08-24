export const HOSTED_CONNECTION_PROVIDERS = [
  "github",
  "slack",
  "linear",
  "fireflies",
  "claude-code",
] as const;

export type HostedConnectionProvider = typeof HOSTED_CONNECTION_PROVIDERS[number];
export type HostedConnectionStatus =
  | "disconnected"
  | "pending"
  | "connected"
  | "degraded"
  | "error";

export interface RawHostedConnectionSummary {
  provider?: unknown;
  status?: unknown;
  display_name?: unknown;
  last_success_at?: unknown;
  last_error_at?: unknown;
  channel_ids?: unknown;
}

export interface HostedConnectionSummary {
  provider: HostedConnectionProvider;
  status: HostedConnectionStatus;
  connected: boolean;
  display_name: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  channel_ids?: string[];
}

function normalizedProvider(value: unknown): HostedConnectionProvider | null {
  if (value === "claude_code") return "claude-code";
  return HOSTED_CONNECTION_PROVIDERS.includes(value as HostedConnectionProvider)
    ? value as HostedConnectionProvider
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rawSummary(value: unknown): RawHostedConnectionSummary | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RawHostedConnectionSummary
    : undefined;
}

export function normalizeHostedConnection(
  provider: HostedConnectionProvider,
  value?: unknown,
): HostedConnectionSummary {
  const raw = rawSummary(value);
  let status: HostedConnectionStatus;
  if (!raw || raw.status === "revoked" || raw.status === null) {
    status = "disconnected";
  } else if (raw.status === "pending") {
    status = "pending";
  } else if (raw.status === "error") {
    status = "error";
  } else if (raw.status === "degraded") {
    status = "degraded";
  } else if (raw.status === "active") {
    status = provider === "fireflies" && !stringOrNull(raw.last_success_at)
      ? "pending"
      : "connected";
  } else {
    status = "disconnected";
  }

  const result: HostedConnectionSummary = {
    provider,
    status,
    connected: status === "connected" || status === "degraded",
    display_name: stringOrNull(raw?.display_name),
    last_success_at: stringOrNull(raw?.last_success_at),
    last_error_at: stringOrNull(raw?.last_error_at),
  };
  if (provider === "slack") {
    result.channel_ids = Array.isArray(raw?.channel_ids)
      ? raw.channel_ids.filter((value): value is string => typeof value === "string")
      : [];
  }
  return result;
}

export function normalizeHostedConnections(
  value: unknown,
): HostedConnectionSummary[] {
  const byProvider = new Map<HostedConnectionProvider, RawHostedConnectionSummary>();
  const rawConnections = Array.isArray(value) ? value : [];
  for (const value of rawConnections) {
    const raw = rawSummary(value);
    if (!raw) continue;
    const provider = normalizedProvider(raw.provider);
    if (provider && !byProvider.has(provider)) byProvider.set(provider, raw);
  }
  return HOSTED_CONNECTION_PROVIDERS.map((provider) =>
    normalizeHostedConnection(provider, byProvider.get(provider))
  );
}
