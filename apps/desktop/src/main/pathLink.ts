// desktop/src/main/pathLink.ts — make ~/.draft/bin/draft resolvable from a shell.
//
// Prefers a symlink at /usr/local/bin/draft; falls back to a PATH line in the
// user's shell profile. Idempotent, so it is safe to run on every launch.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";

export interface PathLinkTargets {
  /** The extracted binary, e.g. ~/.draft/bin/draft. */
  binPath: string;
  /** The system symlink, e.g. /usr/local/bin/draft. */
  link: string;
  home: string;
  shell: string;
}

export interface PathLinkResult {
  label: string;
  ok: boolean;
  error?: string;
}

type LinkState = "current" | "stale" | "foreign" | "missing";

// Only a symlink pointing into ~/.draft is ours to replace. A regular file or
// a link elsewhere (Homebrew, install-cli.sh) belongs to the user.
function systemLinkState(t: PathLinkTargets): LinkState {
  let target: string;
  try {
    if (!lstatSync(t.link).isSymbolicLink()) return "foreign";
    target = readlinkSync(t.link);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "foreign";
  }
  if (target === t.binPath) return "current";
  return target.startsWith(`${t.home}/.draft/`) ? "stale" : "foreign";
}

function profileFor(t: PathLinkTargets): string {
  return t.shell.includes("zsh")  ? join(t.home, ".zprofile")
       : t.shell.includes("bash") ? join(t.home, ".bash_profile")
       :                            join(t.home, ".profile");
}

export function linkOnPath(t: PathLinkTargets): PathLinkResult {
  const state = systemLinkState(t);
  if (state === "current") return { label: "draft already on PATH (/usr/local/bin)", ok: true };
  if (state === "foreign") return { label: "draft already on PATH (/usr/local/bin/draft is not ours — left alone)", ok: true };

  try {
    mkdirSync(join(t.link, ".."), { recursive: true });
    if (state === "stale") unlinkSync(t.link);
    symlinkSync(t.binPath, t.link);
    return { label: "Add draft to PATH (/usr/local/bin)", ok: true };
  } catch {
    // /usr/local/bin needs elevated permissions on most user machines. Append
    // to the shell profile instead (the Cargo/nvm/Homebrew pattern); it takes
    // effect in new terminal sessions.
    const profile = profileFor(t);
    const shown = profile.replace(t.home, "~");
    try {
      const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
      if (existing.includes(".draft/bin")) {
        return { label: `draft already on PATH (${shown})`, ok: true };
      }
      appendFileSync(profile, `\nexport PATH="$HOME/.draft/bin:$PATH"  # added by Draft\n`);
      return { label: `Add draft to PATH (${shown} — open a new terminal to activate)`, ok: true };
    } catch {
      return {
        label: "Add draft to PATH",
        ok: false,
        error: `Could not write to ${profile}. Run manually: echo 'export PATH="$HOME/.draft/bin:$PATH"' >> ${profile}`,
      };
    }
  }
}
