import { HOSTED_CONNECTION_PROVIDERS, type HostedConnectionProvider } from "draft-core/integrations/hosted-connections";

export const DISCONNECT_PROVIDERS = HOSTED_CONNECTION_PROVIDERS;
export type DisconnectProvider = HostedConnectionProvider;
export type NetworkDisconnectProvider = Exclude<HostedConnectionProvider, "claude-code">;

export const PROVIDER_LABELS: Record<HostedConnectionProvider, string> = {
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  fireflies: "Fireflies",
  granola: "Granola",
  "claude-code": "Claude Code",
  google: "Google",
};

export function isDisconnectProvider(value: string): value is DisconnectProvider {
  return (DISCONNECT_PROVIDERS as readonly string[]).includes(value);
}

export function isNetworkDisconnectProvider(value: DisconnectProvider): value is NetworkDisconnectProvider {
  return value !== "claude-code";
}
