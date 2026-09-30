import { useEffect, useRef, type RefObject } from "react";
import type { ContextFileEntry } from "../../rpc/schema";
import { events, rpc } from "../rpc";
import type { Toast } from "./useAppUpdates";

const POLL_MS = 10_000;
const TIMEOUT_MS = 10 * 60_000;


/** After a bootstrap synthesis starts, poll until the first documents land, then reload. */
export function useBootstrapPolling(
  workspaceIdRef: RefObject<string | null>,
  setFiles: (files: ContextFileEntry[]) => void,
  onToast: (toast: Toast) => void,
) {
  const pollRef = useRef<{ cancelled: boolean } | null>(null);
  const setFilesRef = useRef(setFiles);
  const toastRef = useRef(onToast);
  useEffect(() => {
    setFilesRef.current = setFiles;
    toastRef.current = onToast;
  }, [setFiles, onToast]);

  useEffect(() => {
    const off = events.on("bootstrapRunStarted", () => {
      if (pollRef.current) pollRef.current.cancelled = true; // supersede any earlier poll
      const token = { cancelled: false };
      pollRef.current = token;
      const startedForWorkspaceId = workspaceIdRef.current;
      const deadline = Date.now() + TIMEOUT_MS;

      void (async () => {
        while (!token.cancelled && workspaceIdRef.current === startedForWorkspaceId && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
          if (token.cancelled || workspaceIdRef.current !== startedForWorkspaceId) return;
          let files: ContextFileEntry[];
          try {
            files = await rpc.request.getContextFiles();
          } catch {
            continue;
          }
          if (token.cancelled || workspaceIdRef.current !== startedForWorkspaceId) return;
          if (files.length > 0) {
            setFilesRef.current(files);
            toastRef.current({ type: "success", msg: "Your workspace context is ready." });
            return;
          }
        }
        if (!token.cancelled && workspaceIdRef.current === startedForWorkspaceId) {
          toastRef.current({ type: "error", msg: "Still setting up your workspace — check the Context tab again shortly." });
        }
      })();
    });
    return () => {
      off();
      if (pollRef.current) pollRef.current.cancelled = true;
    };
  }, [workspaceIdRef]);
}
