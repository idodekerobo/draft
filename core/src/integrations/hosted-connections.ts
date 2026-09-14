export const HOSTED_CONNECTION_PROVIDERS = [
  "github",
  "slack",
  "linear",
  "fireflies",
  "granola",
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
  backfill?: unknown;
  id?: unknown;
  is_mine?: unknown;
  account_kind?: unknown;
}

export interface HostedConnectionBackfillSummary {
  status: string;
  cutoff: string | null;
  completed_at: string | null;
  last_error: string | null;
}

export interface HostedConnectionSummary {
  provider: HostedConnectionProvider;
  status: HostedConnectionStatus;
  connected: boolean;
  display_name: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  channel_ids?: string[];
  backfill?: HostedConnectionBackfillSummary;
}

export function normalizeBackfillSummary(value: unknown): HostedConnectionBackfillSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.status !== "string") return undefined;
  return {
    status: raw.status,
    cutoff: typeof raw.cutoff === "string" ? raw.cutoff : null,
    completed_at: typeof raw.completed_at === "string" ? raw.completed_at : null,
    last_error: typeof raw.last_error === "string" ? raw.last_error : null,
  };
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
    // Webhook-driven providers need a proven delivery, not just a saved
    // credential, before they count as "connected".
    status = (provider === "fireflies" || provider === "granola") && !stringOrNull(raw.last_success_at)
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
    const backfill = normalizeBackfillSummary(raw?.backfill);
    if (backfill) result.backfill = backfill;
  }
  return result;
}

export interface HostedConnectionListItem extends HostedConnectionSummary {
  id: string | null;
  is_mine: boolean;
  // Only meaningful for Granola: distinguishes a caller-owned personal-key
  // row from the workspace's single shared workspace-key row.
  account_kind?: "personal" | "workspace";
}

// Settings-list-only: unlike normalizeHostedConnections (which folds to one
// row per provider for every other consumer), this returns every row a
// multi-account provider has -- one per connecting teammate. Deliberately
// separate from normalizeHostedConnection/normalizeHostedConnections so
// every other caller's folded shape is untouched.
export function normalizeHostedConnectionList(
  provider: HostedConnectionProvider,
  value: unknown,
): HostedConnectionListItem[] {
  const rawConnections = Array.isArray(value) ? value : [];
  const matches = rawConnections
    .map((entry) => rawSummary(entry))
    .filter((raw): raw is RawHostedConnectionSummary => !!raw && normalizedProvider(raw.provider) === provider);

  if (matches.length === 0) {
    return [{ ...normalizeHostedConnection(provider), id: null, is_mine: false }];
  }

  return matches.map((raw) => ({
    ...normalizeHostedConnection(provider, raw),
    id: typeof raw.id === "string" ? raw.id : null,
    is_mine: raw.is_mine === true,
    ...(raw.account_kind === "personal" || raw.account_kind === "workspace"
      ? { account_kind: raw.account_kind }
      : {}),
  }));
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
