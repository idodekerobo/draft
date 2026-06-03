// desktop/src/main/bundlePath.ts — resolve bundled asset paths at runtime
//
// Works in two modes:
//   Bundle mode  — running inside Draft.app/Contents/MacOS/launcher
//                  resolves to Draft.app/Contents/Resources/<asset>
//   Dev mode     — running via `electrobun dev` or `bun run src/index.ts`
//                  falls back to sibling repo directories

import { join } from "path";

/**
 * Returns Draft.app/Contents/Resources/ when running inside a .app bundle.
 * Returns null in dev mode.
 *
 * Detection: in a bundle, process.execPath ends with
 *   .../Draft.app/Contents/MacOS/launcher (or bun)
 */
export function getBundleResourcesPath(): string | null {
  const execPath = process.execPath;
  const marker = ".app/Contents/MacOS/";
  const idx = execPath.indexOf(marker);
  if (idx === -1) return null;
  const appPath = execPath.slice(0, idx + ".app".length);
  return join(appPath, "Contents", "Resources");
}

/** Path to bundled background/ daemon scripts. Falls back to repo sibling in dev mode. */
export function getBundledBackgroundDir(): string {
  const resources = getBundleResourcesPath();
  // Electrobun places copy: assets under Resources/app/, not Resources/ directly
  if (resources) return join(resources, "app", "background");
  // Dev fallback: desktop/ is one level below repo root
  return join(import.meta.dir, "../../../background");
}

/** Path to bundled cli-agent-plugin/ assets. Falls back to repo sibling in dev mode. */
export function getBundledPluginDir(): string {
  const resources = getBundleResourcesPath();
  // Electrobun places copy: assets under Resources/app/, not Resources/ directly
  if (resources) return join(resources, "app", "plugin");
  return join(import.meta.dir, "../../../cli-agent-plugin");
}

/** Path to bundled compiled draft binary. Returns null in dev mode (binary not compiled). */
export function getBundledBinPath(): string | null {
  const execPath = process.execPath;
  const marker = ".app/Contents/MacOS/";
  const idx = execPath.indexOf(marker);
  if (idx === -1) return null;
  const appPath = execPath.slice(0, idx + ".app".length);
  return join(appPath, "Contents", "MacOS", "draft");
}
