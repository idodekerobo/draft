// desktop/src/main/watchers/proposals.ts — proposals/ fs.watch + fallback poll

import { existsSync, watch } from "fs";
import { listProposals } from "draft-core/proposals";
import { getActiveProfile, getWorkspacePath } from "draft-core/config";
import { notifyNewProposal } from "../notifications";

interface ProposalWatchHandlers {
  onBadgeUpdate: (count: number) => void;
  onProposalAdded: (source: string, count: number) => void;
}

const FALLBACK_POLL_MS = 60_000;

let proposalWatcher: ReturnType<typeof watch> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let lastCount = 0;
let started = false;

export function startProposalWatch(handlers: ProposalWatchHandlers): void {
  if (started) return;
  started = true;

  const reconcile = (notify: boolean) => {
    const workspace = getWorkspacePath(getActiveProfile());
    const proposals = listProposals(workspace);
    const count = proposals.length;

    if (count !== lastCount) {
      handlers.onBadgeUpdate(count);

      if (notify && count > lastCount) {
        const newest = proposals[proposals.length - 1];
        const addedCount = count - lastCount;
        const source = newest?.source ?? "unknown";
        handlers.onProposalAdded(source, addedCount);
        notifyNewProposal(source, addedCount);
      }

      lastCount = count;
    }
  };

  reconcile(false);
  startDirectoryWatch(reconcile);
  fallbackTimer = setInterval(() => reconcile(true), FALLBACK_POLL_MS);
}

export function stopProposalWatch(): void {
  proposalWatcher?.close();
  proposalWatcher = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  started = false;
}

function startDirectoryWatch(reconcile: (notify: boolean) => void): void {
  const proposalsDir = `${getWorkspacePath(getActiveProfile())}/proposals`;
  if (!existsSync(proposalsDir)) return;

  try {
    proposalWatcher = watch(proposalsDir, { persistent: false }, () => {
      reconcile(true);
    });
  } catch {
    // Fallback poll remains active.
  }
}
