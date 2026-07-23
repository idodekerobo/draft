import { existsSync } from "fs";
import { delimiter, join } from "path";

export type RuntimeEntrypointKind = "js" | "ts" | "sh";

export interface RuntimeEntrypoint {
  path: string;
  kind: RuntimeEntrypointKind;
}

type RuntimeResolveOptions = {
  exists?: (path: string) => boolean;
  home?: string;
  path?: string;
};

/** Resolve installed runtime code in deployment order: bundled JS, TS source, shell fallback. */
export function resolveRuntimeEntrypoint(
  pathWithoutExtension: string,
  options: RuntimeResolveOptions = {},
): RuntimeEntrypoint | null {
  const pathExists = options.exists ?? existsSync;
  for (const kind of ["js", "ts", "sh"] as const) {
    const candidate = `${pathWithoutExtension}.${kind}`;
    if (pathExists(candidate)) return { path: candidate, kind };
  }
  return null;
}

/**
 * Resolve Bun without relying on launchd/Finder's stripped PATH. Draft's bundled
 * runtime is installed under ~/.draft/bin and intentionally wins over system Bun.
 */
export function resolveBunExecutable(options: RuntimeResolveOptions = {}): string | null {
  const pathExists = options.exists ?? existsSync;
  const home = options.home ?? process.env.HOME ?? "";
  const searchPath = options.path ?? process.env.PATH ?? "";
  const candidates = [
    home ? join(home, ".draft", "bin", "bun") : "",
    home ? join(home, ".bun", "bin", "bun") : "",
    ...searchPath.split(delimiter).filter(Boolean).map((dir) => join(dir, "bun")),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ];
  for (const candidate of candidates) {
    if (candidate && pathExists(candidate)) return candidate;
  }
  return null;
}

export function runtimeCommand(
  entrypoint: RuntimeEntrypoint,
  args: string[] = [],
  options: RuntimeResolveOptions = {},
): string[] | null {
  if (entrypoint.kind === "sh") return ["bash", entrypoint.path, ...args];
  const bun = resolveBunExecutable(options);
  return bun ? [bun, "run", entrypoint.path, ...args] : null;
}
