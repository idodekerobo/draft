// version.ts — the installed CLI's own version, baked in at compile time via
// --define (see scripts/build.ts). Falls back to "0.0.0-dev" for `bun run`.

export const CLI_VERSION = process.env.DRAFT_CLI_VERSION || "0.0.0-dev";
