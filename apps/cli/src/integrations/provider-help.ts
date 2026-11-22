// integrations/provider-help.ts — what one provider adds to `draft connections <command> --provider <name> --help`.
// A provider that needs more than the shared page adds its text here, keyed by provider and then by command.

const GMAIL_SEARCH = `Gmail:
  Searches the mailbox of the person you work for, newest first. Nothing is stored.
  --query takes Gmail search syntax, as in the Gmail search box:
    cal meeting            both words, anywhere in the message
    "cal meeting"          the exact phrase
    from:ada subject:plan  by sender and subject
    has:attachment         messages with a file
  --since and --until are added as after: and before:. Each result shows its id; read it with:
    draft connections read --provider gmail --message-id <id>
  Gmail and Google Drive connect together: draft connections connect --provider google
`;

const GMAIL_READ = `Gmail:
  --message-id reads one message and --thread-id a whole thread, as plain text. Long text is cut at
  --max-bytes; the "More:" line holds the command for the rest. --message-id with --attachment-id
  downloads one attachment, in parts, as base64 (over 10 MB is refused).
`;

export const PROVIDER_HELP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "google-drive": {
    list: `Google Drive: lists your synced folders and last sync. Add --available to browse folders and shared drives; --query filters names and --cursor continues the page.`,
    search: `Google Drive: --query searches stored file text. --include-history searches older versions; --file-id narrows to a file. --since and --until take ISO dates.`,
    read: `Google Drive: --file-id is required. Use --version or --as-of for history, --include versions to list captured versions, and --max-bytes with --cursor for long files.`,
    join: `Google Drive: --folder takes a Google folder or shared drive id. Its files become shared company context.`,
    leave: `Google Drive: --folder takes a synced folder id from connections list. Captured files stay.`,
  },
  gmail: { search: GMAIL_SEARCH, read: GMAIL_READ },
};

export const providerHelp = (provider: string | undefined, subcommand: string): string | undefined =>
  provider ? PROVIDER_HELP[provider]?.[subcommand] : undefined;
