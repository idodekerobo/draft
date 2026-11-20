// integrations/help.ts — usage text for `draft connections`. Each subcommand has its own page so agents read only what they need.
// `list --provider slack --help` is the page for every way to browse Slack's channels.

import { HOSTED_CONNECTION_PROVIDERS } from "draft-core/integrations/hosted-connections";
import { providerHelp } from "./provider-help.ts";
import { DISCONNECT_PROVIDERS } from "./types.ts";

const PROVIDERS = HOSTED_CONNECTION_PROVIDERS.join(", ");
const DISCONNECTABLE_PROVIDERS = DISCONNECT_PROVIDERS.filter((provider) => provider !== "claude-code").join(", ");

export function integrationsGroupHelp(): string {
  return `Usage: draft connections <command> [options]

Commands:
  list                                   Show each connection: status, what it brings in, what you can do with it
  connect --provider <provider>          Connect a provider (prints a link with --json or without a terminal)
  disconnect --provider <provider>       Disconnect a provider (--yes to confirm)
  join --provider <provider> ...         Have the bot join channels, or choose the folders Draft syncs
  leave --provider <provider> ...        Have the bot leave channels, or stop syncing folders
  read --provider <provider> ...         Read from a connected provider: Slack channel messages, a Gmail message, a Drive file
  search --provider <provider> ...       Search a connected provider (see list for which can)
  post --provider <provider> ...         Post a message through a connected provider (slack)
  drive folders list|add|remove  Manage synced Google Drive folders
  drive status                Show synced folders and last sync

Every command takes the provider as a flag, never as a bare word.
Run \`draft connections <command> --help\` for details.
For every way to see Slack's channels, run \`draft connections list --provider slack --help\`.
`;
}

function slackListHelp(): string {
  return `Usage: draft connections list --provider slack [--available [--query <text>] [--limit <n>] [--cursor <cursor>]] [--json]

Slack: whether it is connected, which channels the bot is in, and every public channel you could add.

What each form shows:
  draft connections list --provider slack
      Slack's status and the channels the bot has joined, with their ids.
  draft connections list --provider slack --available
      Also every public channel, biggest first: name, id, member count, and whether the bot is in it
      ("in" or "not in"). The channels the bot is already in are listed too. 50 per page.
  draft connections list --provider slack --available --query eng
      Only channels whose name contains "eng". Case and a leading # do not matter.
  draft connections list --provider slack --available --limit 100
      How many channels per page, 1 to 100.
  draft connections list --provider slack --available --cursor '<cursor>'
      The next page. A page that has more ends with a "More:" line holding the exact command to run.
      The last page has none.
  draft connections list --provider slack --json
  draft connections list --provider slack --available --json
      The same, as JSON: "channels" is the joined list, and with --available, "available.channels" is
      the page and "available.nextCursor" is the cursor for the next page (null on the last).

Flags:
  --provider slack   Required for --available (people only; a routine sees the channels it may use)
  --available        Also list every public channel, whether or not the bot is in it
  --query <text>     With --available: only channels whose name contains this
  --limit <n>        With --available: channels per page, 1 to 100 (default 50)
  --cursor <cursor>  With --available: the cursor of the previous page
  --json             Print the tool's output as JSON

Then, with an id or #name from the list:
  draft connections join --provider slack --channel '#eng'            Add channels (comma separated)
  draft connections leave --provider slack --channel '#eng'           Remove channels
  draft connections read --provider slack --channel '#eng'            Read recent messages
  draft connections post --provider slack --channel '#eng' --text '…' Post a message
`;
}

const SEARCH_HELP = `Usage: draft connections search --provider <provider> --query <text> [--since <date>] [--until <date>] [--limit <n>] [--cursor <cursor>] [--json]

Searches a connected provider live and prints one line per result: date, title, a snippet and its id.
Providers that support it are listed under "you can" by \`draft connections list\`. Read a result with
\`draft connections read\` and its id. A page that has more ends with a "More:" line holding the exact
command for the next page.

Slack has no live search. Messages Draft stored are searched with \`draft sources search --provider slack\`.

Flags:
  --provider <provider>  The provider to search (required)
  --query <text>         What to look for (required). Each provider says which syntax it takes
  --since <date>         Only items on or after this ISO date
  --until <date>         Only items before this ISO date
  --limit <n>            How many results, 1 to 50 (default 20)
  --cursor <cursor>      The cursor of the previous page
  --file-id <id>         Google Drive: only inside this file
  --include-history      Google Drive: also search older versions
  --json                 Print the tool's output as JSON

Example:
  draft connections search --provider <provider> --query 'quarterly plan' --since 2026-10-01 --limit 10
`;

export function integrationsSubcommandHelp(subcommand: string, provider?: string): string | null {
  const base = baseSubcommandHelp(subcommand, provider);
  const extra = providerHelp(provider, subcommand);
  return base !== null && extra ? `${base}\n${extra}` : base;
}

function baseSubcommandHelp(subcommand: string, provider?: string): string | null {
  switch (subcommand) {
    case "search":
      return SEARCH_HELP;
    case "drive":
      return `Usage: draft connections drive folders list [--json]
       draft connections drive folders add <folder-or-shared-drive-id> [--json]
       draft connections drive folders remove <synced-folder-id> [--json]
       draft connections drive status [--json]

Connect first with draft connections connect --provider google (Gmail and Google Drive).
Every file in these folders goes into company context, including files only you can see.
Remove uses the synced folder ID from folders list. Disconnect keeps captured files.
`;
    case "list":
      if (provider === "slack") return slackListHelp();
      return `Usage: draft connections list [--provider <provider>] [--available [--query <text>] [--limit <n>] [--cursor <cursor>]] [--json]

Shows every provider: whether it is connected and whether you connected it,
what it brings in, the routine triggers and abilities it unlocks, what you can
do with it, and the command that connects it. For Slack it also lists the
channels the bot has joined. Start here to learn what to pass to join, read and post.

Providers: ${PROVIDERS}

Flags:
  --provider <provider>  Only this provider
  --available            With --provider slack: also list every public channel and whether the bot is in it
  --query <text>         With --available: only channels whose name contains this
  --limit <n>            With --available: channels per page, 1 to 100 (default 50)
  --cursor <cursor>      With --available: the cursor of the previous page
  --json                 Print the tool's output unchanged, as JSON

Examples:
  draft connections list
  draft connections list --provider slack
  draft connections list --provider slack --available --query eng
  draft connections list --json

For every way to see Slack's channels: draft connections list --provider slack --help
`;
    case "connect":
      return `Usage: draft connections connect --provider <provider> [--json] [--wait]

Providers: ${PROVIDERS}

With --json or without a terminal it prints a link for the person to open;
the key never passes through the CLI. Add --wait to wait until connected.
If the provider is already connected it says so and prints no link.

In a terminal, without --json, it runs the interactive flow (a prompt for the
key, or a browser handoff). For Slack, that flow also asks which channels to join.
To change channels later, use join and leave.

Flags:
  --provider <provider>  The provider to connect (required)
  --json                 Print the link as one JSON line: {"status":"action_required",...}
  --wait                 After the link, check every 3 seconds until connected or the link expires
  --credential-stdin     Read the key from stdin (linear, claude-code, slack, granola)
  --credential-fd <n>    Read the key from file descriptor n (linear, claude-code, slack, granola)
  --no-open              Do not open a browser (github, slack, fireflies; terminal flow only)
  --workspace-key        Connect the workspace's shared Granola key (granola; terminal flow only)

Examples:
  draft connections connect --provider linear
  draft connections connect --provider linear --json --wait
  draft connections connect --provider granola --workspace-key
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
    case "join":
      return `Usage: draft connections join --provider <provider> [--channel <channel>[,<channel>...]] [--json]

Have a connected provider join channels. Providers that support it: slack (its bot joins public channels,
so Draft reads them and a routine can post in them). It changes only the channels you name and says which
it joined, which it was already in, and which failed.

--channel takes channel ids or #names, separated by commas. To see which channels exist and which the bot
is already in: draft connections list --provider slack --available

Without --channel, in a terminal and without --json, it shows the 100 biggest channels the bot is not in
and asks which to join. A script or an agent has no terminal, so it must pass --channel.

Flags:
  --provider <provider>  The provider (required)
  --channel <list>       Channels to join, ids or #names, comma separated
  --folder <list>        Google Drive: folder ids to sync, comma separated (not with --channel)
  --json                 Print the result as JSON

Examples:
  draft connections join --provider slack --channel '#eng'
  draft connections join --provider slack --channel '#eng,#ops,C0123ABC'
  draft connections join --provider slack
`;
    case "leave":
      return `Usage: draft connections leave --provider <provider> --channel <channel>[,<channel>...] [--json]

Have a connected provider leave channels. Providers that support it: slack (its bot leaves public channels
and Draft stops reading them; messages already read stay). It changes only the channels you name and says
which it left and which it was not in.

--channel takes channel ids or #names, separated by commas. To see the channels the bot is in:
draft connections list --provider slack

Flags:
  --provider <provider>  The provider (required)
  --channel <list>       Channels to leave, ids or #names, comma separated
  --folder <list>        Google Drive: folder ids to stop syncing, comma separated (not with --channel)
  --json                 Print the result as JSON

Examples:
  draft connections leave --provider slack --channel '#eng'
  draft connections leave --provider slack --channel '#eng,#ops'
`;
    case "read":
      return `Usage: draft connections read --provider <provider> [--channel <channel> [--limit <n>]] [--message-id <id> | --thread-id <id>] [--file-id <id>] [--json]

Reads from a connected provider. Each provider takes its own flags, and refuses a call that lacks them.
\`draft connections list\` shows what each provider takes.

Slack: --channel is a channel id or #name the bot has joined (\`draft connections list --provider slack\`
shows them). Read before you post, and do not repeat a message already sent.
Gmail: --message-id or --thread-id, from \`draft connections search\`. Add --attachment-id to download one attachment.
Google Drive: --file-id, from \`draft connections search\`. Add --version or --as-of to pick a version.

Flags:
  --provider <provider>  The provider to read from (required)
  --channel <channel>    Slack: the channel to read (required for Slack)
  --limit <n>            Slack: how many recent messages, 1 to 50 (default 20)
  --message-id <id>      Gmail: one message
  --thread-id <id>       Gmail: a whole thread
  --attachment-id <id>   Gmail, with --message-id: one attachment
  --file-id <id>         Google Drive: a file
  --version <id>         Google Drive: a version of the file
  --as-of <time>         Google Drive: the version current at this ISO time
  --include versions     Google Drive: also list the file's stored versions
  --max-bytes <n>        Gmail and Google Drive: how many bytes to return at a time
  --cursor <cursor>      Gmail and Google Drive: the cursor of the previous page. A page that has more ends with a "More:" line
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
