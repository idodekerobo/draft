// desktop/src/main/watchers/proposals.ts — proposals/ fs.watch + fallback poll

import { mkdirSync, watch } from "fs";
import { listProposals } from "draft-core/proposals";
import { getWorkspacePath } from "draft-core/config";
import { notifyNewProposal } from "../notifications";

export interface ProposalWatchHandlers {
  onBadgeUpdate: (profile: string, count: number) => void;
  onProposalAdded: (profile: string, source: string, count: number) => void;
}

const FALLBACK_POLL_MS = 60_000;

let proposalWatcher: ReturnType<typeof watch> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let lastCount = 0;
let started = false;
let watchedProfile: string | null = null;

export function startProposalWatch(profile: string, handlers: ProposalWatchHandlers): void {
  if (started) return;
  started = true;
  watchedProfile = profile;
  lastCount = 0;

  const reconcile = (notify: boolean) => {
    if (!watchedProfile) return;
    const workspace = getWorkspacePath(watchedProfile);
    const proposals = listProposals(workspace);
    const count = proposals.length;

    if (count !== lastCount) {
      handlers.onBadgeUpdate(watchedProfile, count);

      if (notify && count > lastCount) {
        const newest = proposals[proposals.length - 1];
        const addedCount = count - lastCount;
        const source = newest?.source ?? "unknown";
        handlers.onProposalAdded(watchedProfile, source, addedCount);
        notifyNewProposal(source, addedCount);
      }

      lastCount = count;
    }
  };

  reconcile(false);
  startDirectoryWatch(reconcile);
  fallbackTimer = setInterval(() => reconcile(true), FALLBACK_POLL_MS);
}

export function restartProposalWatch(profile: string, handlers: ProposalWatchHandlers): void {
  stopProposalWatch();
  startProposalWatch(profile, handlers);
}

export function stopProposalWatch(): void {
  proposalWatcher?.close();
  proposalWatcher = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  started = false;
  watchedProfile = null;
  lastCount = 0;
}

function startDirectoryWatch(reconcile: (notify: boolean) => void): void {
  if (!watchedProfile) return;
  const proposalsDir = `${getWorkspacePath(watchedProfile)}/proposals`;
  mkdirSync(proposalsDir, { recursive: true });

  try {
    proposalWatcher = watch(proposalsDir, { persistent: false }, () => {
      reconcile(true);
    });
  } catch {
    // Fallback poll remains active.
  }
}
