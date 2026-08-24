import type { HostedConnectionProvider } from "draft-core/integrations/hosted-connections";

export const NETWORK_DISCONNECT_PROVIDERS = ["github", "fireflies", "linear", "slack"] as const;
export type NetworkDisconnectProvider = typeof NETWORK_DISCONNECT_PROVIDERS[number];

// Grammar-level superset: "claude-code" parses as a recognized disconnect target so it gets a
// deterministic not_supported result, not a generic invalid_usage grammar error.
export const DISCONNECT_PROVIDERS = [...NETWORK_DISCONNECT_PROVIDERS, "claude-code"] as const;
export type DisconnectProvider = typeof DISCONNECT_PROVIDERS[number];

export const BACKEND_PROVIDER_BY_CLI: Record<NetworkDisconnectProvider, NetworkDisconnectProvider> = {
  github: "github",
  fireflies: "fireflies",
  linear: "linear",
  slack: "slack",
};

export const PROVIDER_LABELS: Record<HostedConnectionProvider, string> = {
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  fireflies: "Fireflies",
  "claude-code": "Claude Code",
};

export function isDisconnectProvider(value: string): value is DisconnectProvider {
  return (DISCONNECT_PROVIDERS as readonly string[]).includes(value);
}

export function isNetworkDisconnectProvider(value: DisconnectProvider): value is NetworkDisconnectProvider {
  return (NETWORK_DISCONNECT_PROVIDERS as readonly string[]).includes(value);
}
