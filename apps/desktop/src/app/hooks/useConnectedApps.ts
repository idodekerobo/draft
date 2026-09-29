import { useCallback, useEffect, useState } from "react";
import type { ConnectedAppsStatus } from "../../rpc/schema";
import { rpc } from "../rpc";

export function useConnectedApps() {
  const [apps, setApps] = useState<ConnectedAppsStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      setApps(await rpc.request.getConnectedApps());
      setFailed(false);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  return { apps, failed, refresh };
}
