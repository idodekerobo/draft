import { useEffect, useState } from "react";
import { events, rpc } from "../rpc";

export type Toast = { type: "success" | "error"; msg: string };

export function useAppUpdates() {
  const [updateReady, setUpdateReady] = useState(false);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [updateToast, setUpdateToast] = useState<Toast | null>(null);

  useEffect(() => {
    const unsubs = [
      events.on("updateAvailable", ({ version }) => {
        setUpdateVersion(version);
        setUpdateReady(true);
      }),
      events.on("updateNotAvailable", () => {
        setUpdateToast({ type: "success", msg: "Draft is up to date" });
      }),
      events.on("updateCheckFailed", ({ error }) => {
        setUpdateToast({ type: "error", msg: error });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    if (!updateToast) return;
    const id = setTimeout(() => setUpdateToast(null), 3_500);
    return () => clearTimeout(id);
  }, [updateToast]);

  async function applyUpdate() {
    setIsApplyingUpdate(true);
    try {
      await rpc.request.applyUpdate();
      // App restarts — this line is usually not reached.
    } catch {
      setUpdateToast({ type: "error", msg: "Failed to apply update. Try again." });
      setIsApplyingUpdate(false);
    }
  }

  return {
    updateReady,
    updateVersion,
    isApplyingUpdate,
    updateToast,
    dismissUpdatePill: () => setUpdateReady(false),
    dismissUpdateToast: () => setUpdateToast(null),
    applyUpdate,
  };
}
