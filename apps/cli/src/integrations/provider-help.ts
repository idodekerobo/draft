// integrations/provider-help.ts — what one provider adds to `draft connections <command> --provider <name> --help`.
// A provider that needs more than the shared page adds its text here, keyed by provider and then by command.

export const PROVIDER_HELP: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

export const providerHelp = (provider: string | undefined, subcommand: string): string | undefined =>
  provider ? PROVIDER_HELP[provider]?.[subcommand] : undefined;
