"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GithubInstallPhase } from "draft-shared-ui";
import { apiFetch } from "@/lib/api";
import { pollInstallSession, type InstallSessionStatus } from "@/lib/github-install-poll";

const TAB_CLOSED_GRACE_MS = 6_000;

interface InstallSession {
  code: string;
  installUrl: string;
}

/** Web version of the desktop GitHub install: open GitHub's install page in a tab and poll until it finishes. */
export function useGithubInstall(workspaceId: string, onConnected: () => void | Promise<void>) {
  const [phase, setPhase] = useState<GithubInstallPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  // Bumped to cancel a running poll, on retry, cancel or unmount.
  const runRef = useRef(0);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);
  useEffect(() => () => { runRef.current += 1; }, []);

  const cancel = useCallback(() => {
    runRef.current += 1;
    setPhase("idle");
    setError(null);
  }, []);

  const connect = useCallback(async () => {
    runRef.current += 1;
    const run = runRef.current;
    setError(null);
    setPhase("awaiting_approval");

    // Browsers only allow a new tab straight from the click, so open it before the request.
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setPhase("error");
      setError("Your browser blocked the GitHub window. Allow pop-ups for Draft and try again.");
      return;
    }
    tab.opener = null;

    function fail(message: string) {
      try { tab?.close(); } catch {}
      setPhase("error");
      setError(message);
    }

    let session: InstallSession;
    try {
      session = await apiFetch<InstallSession>(`/workspaces/${workspaceId}/github/install-sessions`, { method: "POST" });
    } catch {
      if (runRef.current === run) fail("Could not start the GitHub install. Try again.");
      return;
    }
    if (runRef.current !== run) {
      try { tab.close(); } catch {}
      return;
    }
    tab.location.href = session.installUrl;

    // The GitHub tab often closes right after a successful install, so keep polling briefly before giving up.
    let tabClosedAt: number | null = null;
    const result = await pollInstallSession({
      fetchStatus: () => apiFetch<InstallSessionStatus>(`/workspaces/${workspaceId}/github/install-sessions/${session.code}`),
      isCancelled: () => {
        if (runRef.current !== run) return true;
        if (!tab.closed) return false;
        tabClosedAt ??= Date.now();
        return Date.now() - tabClosedAt > TAB_CLOSED_GRACE_MS;
      },
    });
    if (runRef.current !== run) return;
    if (result.outcome === "connected") {
      try { tab.close(); } catch {}
      setPhase("connected");
      await onConnectedRef.current();
    } else if (result.outcome === "error") {
      fail(result.message);
    } else {
      // The person closed the GitHub tab without finishing.
      setPhase("idle");
    }
  }, [workspaceId]);

  return { phase, error, connect, cancel };
}
