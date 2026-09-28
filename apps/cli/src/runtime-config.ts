// runtime-config.ts — hosted CLI configuration
//
// DRAFT_API_BASE_URL / DRAFT_APP_URL default to production and can be
// overridden for local development (matches the desktop app's convention).
// DRAFT_SUPABASE_URL / DRAFT_SUPABASE_PUBLISHABLE_KEY have no runtime
// default: the source-run path (`bun run src/index.ts`) reads them from
// the shell environment, and the compiled path (`bun build --compile`)
// bakes them in at build time via `--define` (see scripts/build.ts) so a
// distributed binary works without the end user exporting anything.

export interface CliRuntimeConfig {
  apiBaseUrl: string;
  appUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export class MissingCliConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`missing required configuration: ${missing.join(", ")}`);
    this.name = "MissingCliConfigError";
  }
}

export function getCliRuntimeConfig(): CliRuntimeConfig {
  const apiBaseUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";
  const appUrl = process.env.DRAFT_APP_URL ?? "https://app.draftai.us";
  const supabaseUrl = process.env.DRAFT_SUPABASE_URL ?? "";
  const supabasePublishableKey = process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "";

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("DRAFT_SUPABASE_URL");
  if (!supabasePublishableKey) missing.push("DRAFT_SUPABASE_PUBLISHABLE_KEY");
  if (missing.length > 0) throw new MissingCliConfigError(missing);

  return { apiBaseUrl, appUrl, supabaseUrl, supabasePublishableKey };
}
