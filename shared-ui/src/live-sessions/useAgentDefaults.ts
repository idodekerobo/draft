import { useEffect, useState } from "react";
import type { AgentDefaultsView } from "../controls/agent-picker";

export type AgentDefaultsLoader = (harness: string) => Promise<AgentDefaultsView>;

/** What "Default" means for a harness on this computer, or null while it loads or when the app cannot say. */
export function useAgentDefaults(load: AgentDefaultsLoader | undefined, harness: string): AgentDefaultsView | null {
  const [defaults, setDefaults] = useState<AgentDefaultsView | null>(null);
  useEffect(() => {
    setDefaults(null);
    if (!load) return;
    let cancelled = false;
    load(harness).then((value) => !cancelled && setDefaults(value)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [load, harness]);
  return defaults;
}
