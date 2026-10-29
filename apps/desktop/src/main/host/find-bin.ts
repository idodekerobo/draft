import { existsSync, readdirSync } from "fs";

/**
 * macOS GUI apps get a stripped PATH, and ~/.local/bin and nvm paths are set only in interactive shells.
 * So this checks the known install paths directly instead of using `which`.
 */
export function findRunnerBin(name: string): string | null {
  const HOME = process.env.HOME ?? "";
  const knownPaths = [
    `${HOME}/.local/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `${HOME}/.npm-global/bin/${name}`,
  ];
  for (const path of knownPaths) {
    if (existsSync(path)) return path;
  }

  const nvmDir = `${HOME}/.nvm/versions/node`;
  if (existsSync(nvmDir)) {
    try {
      for (const version of readdirSync(nvmDir).reverse()) {
        const path = `${nvmDir}/${version}/bin/${name}`;
        if (existsSync(path)) return path;
      }
    } catch {}
  }
  return null;
}
