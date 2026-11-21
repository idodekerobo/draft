// integrations/help.ts — usage text for `draft connections`. Each subcommand has its own page so agents read only what they need.

import { HOSTED_CONNECTION_PROVIDERS } from "draft-core/integrations/hosted-connections";
import { DISCONNECT_PROVIDERS } from "./types.ts";

const PROVIDERS = HOSTED_CONNECTION_PROVIDERS.join(", ");
const DISCONNECTABLE_PROVIDERS = DISCONNECT_PROVIDERS.filter((provider) => provider !== "claude-code").join(", ");

export function integrationsGroupHelp(): string {
  return `Usage: draft connections <command> [options]

Commands:
  list                                   Show each connection: status, what it brings in, what you can do with it
  connect --provider <provider>          Connect a provider (prints a link with --json or without a terminal)
  disconnect --provider <provider>       Disconnect a provider (--yes to confirm)
  read --provider <provider> ...         Read recent messages from a connected provider (slack)
  post --provider <provider> ...         Post a message through a connected provider (slack)

Every command takes the provider as a flag, never as a bare word.
Run \`draft connections <command> --help\` for details.
`;
}

export function integrationsSubcommandHelp(subcommand: string): string | null {
  switch (subcommand) {
    case "list":
      return `Usage: draft connections list [--provider <provider>] [--json]

Shows every provider: whether it is connected and whether you connected it,
what it brings in, the routine triggers and abilities it unlocks, what you can
do with it, and the command that connects it. For Slack it also lists the
channels the bot has joined. Start here to learn what to pass to read and post.

Providers: ${PROVIDERS}

Flags:
  --provider <provider>  Only this provider
  --json                 Print the tool's output unchanged, as JSON

Examples:
  draft connections list
  draft connections list --provider slack
  draft connections list --json
`;
    case "connect":
      return `Usage: draft connections connect --provider <provider> [--json] [--wait]
       draft connections connect --provider slack --channels <channel>[,<channel>...] [--json]

Providers: ${PROVIDERS}

With --json or without a terminal it prints a link for the person to open;
the key never passes through the CLI. Add --wait to wait until connected.
If the provider is already connected it says so and prints no link.

In a terminal, without --json, it runs the interactive flow (a prompt for the
key, or a browser handoff).

Flags:
  --provider <provider>  The provider to connect (required)
  --json                 Print the link as one JSON line: {"status":"action_required",...}
  --wait                 After the link, check every 3 seconds until connected or the link expires
  --channels <list>      Slack only, once connected: the public channels (ids or #names) the bot
                         should be in, comma separated. They replace the current set.
  --credential-stdin     Read the key from stdin (linear, claude-code, slack, granola)
  --credential-fd <n>    Read the key from file descriptor n (linear, claude-code, slack, granola)
  --no-open              Do not open a browser (github, slack, fireflies; terminal flow only)
  --workspace-key        Connect the workspace's shared Granola key (granola; terminal flow only)

Examples:
  draft connections connect --provider linear
  draft connections connect --provider linear --json --wait
  draft connections connect --provider granola --workspace-key
  draft connections connect --provider slack --channels '#general,#standup'
`;
    case "disconnect":
      return `Usage: draft connections disconnect --provider <provider> [--yes] [--json] [--workspace-key]

Providers: ${DISCONNECTABLE_PROVIDERS}

Without --yes it reports what would stop and changes nothing. Run it again
with --yes to disconnect. Only the person who connected a provider can
disconnect it.

Flags:
  --provider <provider>  The provider to disconnect (required)
  --yes                  Confirm and disconnect
  --json                 Print the result as JSON
  --workspace-key        Disconnect the workspace's shared Granola key (granola only)

Examples:
  draft connections disconnect --provider linear
  draft connections disconnect --provider linear --yes
  draft connections disconnect --provider granola --workspace-key --yes
`;
    case "read":
      return `Usage: draft connections read --provider <provider> --channel <channel> [--limit <n>] [--json]

Reads recent messages from a connected provider. Providers that support it: slack.

Slack: --channel is a channel id or #name the bot has joined (\`draft connections list --provider slack\`
shows them). Read before you post, and do not repeat a message already sent.

Flags:
  --provider <provider>  The provider to read from (required)
  --channel <channel>    The channel to read (required)
  --limit <n>            How many recent messages, 1 to 50 (default 20)
  --json                 Print the tool's output as JSON

Examples:
  draft connections read --provider slack --channel '#general'
  draft connections read --provider slack --channel C0123ABC --limit 5 --json
`;
    case "post":
      return `Usage: draft connections post --provider <provider> --channel <channel> --text <text> [--json]

Posts a message through a connected provider. Providers that support it: slack.

Slack: --channel is a channel id or #name the bot has joined. Draft adds a line saying
who sent it. Use --text - to read the message from stdin.

Flags:
  --provider <provider>  The provider to post through (required)
  --channel <channel>    The channel to post in (required)
  --text <text>          The message (required; - reads stdin)
  --json                 Print the tool's output as JSON

Examples:
  draft connections post --provider slack --channel '#standup' --text 'Deploy is done.'
  echo 'Deploy is done.' | draft connections post --provider slack --channel '#standup' --text -
`;
    default:
      return null;
  }
}
