// desktop/src/main/watchers/activeProfile.ts — watch ~/.draft/active-profile

import { existsSync, watch } from "fs";
import { dirname } from "path";
import { ACTIVE_PROFILE_FILE, getActiveProfile } from "draft-core/config";

interface ActiveProfileWatchHandlers {
  onProfileChanged: (profile: string) => void;
}

let activeProfileWatcher: ReturnType<typeof watch> | null = null;
let lastProfile = getActiveProfile();

export function startActiveProfileWatch(handlers: ActiveProfileWatchHandlers): void {
  const draftRoot = dirname(ACTIVE_PROFILE_FILE);
  if (!existsSync(draftRoot)) return;

  try {
    activeProfileWatcher = watch(draftRoot, { persistent: false }, (_, filename) => {
      if (filename !== "active-profile") return;
      const nextProfile = getActiveProfile();
      if (nextProfile === lastProfile) return;
      lastProfile = nextProfile;
      handlers.onProfileChanged(nextProfile);
    });
  } catch {
    // Non-fatal — desktop-driven switches still restart watchers directly.
  }
}

export function stopActiveProfileWatch(): void {
  activeProfileWatcher?.close();
  activeProfileWatcher = null;
}

