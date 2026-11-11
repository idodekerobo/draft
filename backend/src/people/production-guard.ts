import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const refOf = (url: string | undefined) => url?.match(/^https:\/\/([^.]+)\./)?.[1];

/** The Supabase project ref in an env file's text, or undefined. */
export function projectRefFromEnvText(text: string | undefined): string | undefined {
  const line = text?.split("\n").find((entry) => entry.startsWith("SUPABASE_URL="));
  return refOf(line?.slice("SUPABASE_URL=".length).replace(/["']/g, "").trim());
}

/**
 * Throws when this process points at the production project, unless `allowProd` is set. A script that writes data
 * calls this first. `targetUrl` is the SUPABASE_URL it loaded, and `prodEnvText` is the text of `.env.production`.
 */
export function assertNotProduction(targetUrl: string | undefined, prodEnvText: string | undefined, options: { allowProd?: boolean; what: string }): void {
  const target = refOf(targetUrl);
  if (!target) throw new Error("SUPABASE_URL is not set. Run with --env-file=.env.staging");
  if (target === projectRefFromEnvText(prodEnvText) && !options.allowProd) {
    throw new Error(`This is the production project. ${options.what}`);
  }
}

/** Reads the production env file next to the repo root, when there is one. It only reads the text for its project ref. */
export function readProductionEnvText(fromDir: string): string | undefined {
  const file = resolve(fromDir, "../../../.env.production");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
