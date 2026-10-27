// commands/uninstall.ts — draft uninstall
//
// Removes the CLI binary, its /usr/local/bin link and the PATH line the
// installers add to a shell profile. Leaves the rest of ~/.draft alone: the
// desktop app keeps its data and bun/tmux there.

import { existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "fs";
import { ttyConfirm } from "../integrations/tty-prompt.ts";
import { EXIT_INTERRUPTED, EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { dim, green, red } from "../utils/output.ts";

const PATH_LINE_MARKER = "# added by Draft";

export interface UninstallPaths {
  binPath: string;
  systemLink: string;
  profiles: string[];
}

export interface UninstallResult {
  removed: string[];
  failed: Array<{ path: string; message: string }>;
}

export function defaultUninstallPaths(home: string = process.env.HOME ?? ""): UninstallPaths {
  return {
    binPath: `${home}/.draft/bin/draft`,
    systemLink: "/usr/local/bin/draft",
    profiles: [`${home}/.zprofile`, `${home}/.bash_profile`, `${home}/.profile`],
  };
}

function isLinkTo(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && readlinkSync(link) === target;
  } catch {
    return false;
  }
}

export function performUninstall(paths: UninstallPaths): UninstallResult {
  const result: UninstallResult = { removed: [], failed: [] };
  const attempt = (path: string, fn: () => void) => {
    try {
      fn();
      result.removed.push(path);
    } catch (err) {
      result.failed.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  };

  // Only remove the link if it points at our binary; it may belong to another install.
  if (isLinkTo(paths.systemLink, paths.binPath)) {
    attempt(paths.systemLink, () => unlinkSync(paths.systemLink));
  }

  if (existsSync(paths.binPath)) {
    attempt(paths.binPath, () => unlinkSync(paths.binPath));
  }

  for (const profile of paths.profiles) {
    if (!existsSync(profile)) continue;
    const lines = readFileSync(profile, "utf8").split("\n");
    const kept = lines.filter((l) => !(l.includes(".draft/bin") && l.includes(PATH_LINE_MARKER)));
    if (kept.length === lines.length) continue;
    attempt(profile, () => writeFileSync(profile, kept.join("\n")));
  }

  return result;
}

export async function runUninstall(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const yes = args.includes("--yes");
  const unknown = args.find((a) => a !== "--json" && a !== "--yes");
  if (unknown) {
    if (json) printJsonLine(errorPayload("invalid_usage", `unexpected argument: ${unknown}`));
    else console.error(red(`draft uninstall: unexpected argument: ${unknown}`));
    return EXIT_USAGE_ERROR;
  }

  if (!yes) {
    if (json) {
      printJsonLine(errorPayload("confirmation_required", "pass --yes to uninstall without a prompt"));
      return EXIT_USAGE_ERROR;
    }
    const answer = await ttyConfirm("Remove the draft CLI? Your data in ~/.draft is kept.");
    if (answer === "unavailable") {
      console.error(red("draft uninstall: no terminal to ask on — pass --yes to confirm."));
      return EXIT_USAGE_ERROR;
    }
    if (answer === "interrupted") return EXIT_INTERRUPTED;
    if (answer === "no") {
      console.log("Cancelled.");
      return EXIT_SUCCESS;
    }
  }

  const result = performUninstall(defaultUninstallPaths());
  const ok = result.failed.length === 0;

  if (json) {
    printJsonLine({ status: ok ? "uninstalled" : "partial", removed: result.removed, failed: result.failed });
  } else {
    for (const path of result.removed) console.log(`${green("Removed")} ${path}`);
    for (const f of result.failed) console.error(red(`Could not remove ${f.path}: ${f.message}`));
    if (result.removed.length === 0 && ok) console.log("Nothing to remove.");
    else if (ok) console.log(dim("Your data in ~/.draft was kept."));
  }
  return ok ? EXIT_SUCCESS : EXIT_OPERATIONAL_ERROR;
}
