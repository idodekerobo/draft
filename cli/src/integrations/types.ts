import type { HostedConnectionProvider } from "draft-core/integrations/hosted-connections";

export const DISCONNECT_PROVIDERS = ["github", "fireflies", "linear", "slack"] as const;
export type DisconnectProvider = typeof DISCONNECT_PROVIDERS[number];

export const BACKEND_PROVIDER_BY_CLI: Record<DisconnectProvider, DisconnectProvider> = {
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
