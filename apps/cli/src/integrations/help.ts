// integrations/help.ts — usage text for `draft connections`. Each subcommand has its own page so agents read only what they need.

const PROVIDERS = "github, slack, linear, fireflies, granola, claude-code";

export function integrationsGroupHelp(): string {
  return `Usage: draft connections <command> [options]

Commands:
  list                        Show each integration: status, what it brings in, what it unlocks
  connect <provider>          Connect a provider (prints a link with --json or without a terminal)
  disconnect <provider>       Disconnect a provider
  slack channels list|set     List or set the Slack channels Draft reads

Run \`draft connections <command> --help\` for details.
`;
}

export function integrationsSubcommandHelp(subcommand: string): string | null {
  switch (subcommand) {
    case "list":
      return `Usage: draft connections list [--json]

Shows every provider: whether it is connected and whether you connected it,
what it brings in, the routine triggers and abilities it unlocks, and the
command that connects it.

Providers: ${PROVIDERS}

Flags:
  --json    Print the tool's output unchanged, as JSON

Examples:
  draft connections list
  draft connections list --json
`;
    case "connect":
      return `Usage: draft connections connect <provider> [--json] [--wait]

Providers: ${PROVIDERS}

With --json or without a terminal it prints a link for the person to open;
the key never passes through the CLI. Add --wait to wait until connected.

In a terminal, without --json, it runs the interactive flow (a prompt for the
key, or a browser handoff).

Flags:
  --json                 Print the link as one JSON line: {"status":"action_required",...}
  --wait                 After the link, check every 3 seconds until connected or the link expires
  --credential-stdin     Read the key from stdin (linear, claude-code, slack, granola)
  --credential-fd <n>    Read the key from file descriptor n (linear, claude-code, slack, granola)
  --no-open              Do not open a browser (github, slack, fireflies; terminal flow only)
  --workspace-key        Connect the workspace's shared Granola key (granola; terminal flow only)

Examples:
  draft connections connect linear
  draft connections connect linear --json
  draft connections connect linear --json --wait
  draft connections connect granola --workspace-key
`;
    case "disconnect":
      return `Usage: draft connections disconnect <provider> [--json] [--workspace-key]

Providers: github, slack, linear, fireflies, granola

Flags:
  --json             Print the result as JSON
  --workspace-key    Disconnect the workspace's shared Granola key (granola only)

Examples:
  draft connections disconnect linear
  draft connections disconnect granola --workspace-key
`;
    case "slack":
      return `Usage: draft connections slack channels list [--json]
       draft connections slack channels set <channel-id>... [--json]

Lists the Slack channels Draft can read, or sets the channels it reads.

Flags:
  --json    Print the result as JSON

Examples:
  draft connections slack channels list
  draft connections slack channels set C0123ABC C0456DEF
`;
    default:
      return null;
  }
}
