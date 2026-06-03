// desktop/src/app/analytics/AnalyticsContext.tsx
// PostHog is never imported outside this file — it is the single SDK boundary.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { AnalyticsConfig } from "../../rpc/schema";
import type { AnalyticsEvent } from "./events";
import { rpc } from "../rpc";

interface AnalyticsContextValue {
  track: <E extends AnalyticsEvent>(
    event: E["event"],
    props: Extract<AnalyticsEvent, { event: E["event"] }>["props"]
  ) => void;
  ready: boolean;
  config: AnalyticsConfig | null;
  setConsent: (granted: boolean) => Promise<void>;
  setReplayEnabled: (enabled: boolean) => Promise<void>;
}

const AnalyticsContext = createContext<AnalyticsContextValue>({
  track: () => {},
  ready: false,
  config: null,
  setConsent: async () => {},
  setReplayEnabled: async () => {},
});

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AnalyticsConfig | null>(null);

  useEffect(() => {
    async function init() {
      const cfg = await rpc.request.getAnalyticsConfig();
      setConfig(cfg);
      if (cfg.consent !== "opted_in") return;
      // posthog.init(cfg) goes here when posthog-js is installed
      console.debug("[analytics] init", cfg.anonymous_id);
      setReady(true);
    }
    void init();
  }, []);

  const track = useCallback(
    <E extends AnalyticsEvent>(
      event: E["event"],
      props: Extract<AnalyticsEvent, { event: E["event"] }>["props"]
    ) => {
      if (!ready) return;
      // posthog.capture(event, props) goes here when posthog-js is installed
      console.debug("[analytics] track", event, props);
    },
    [ready]
  );

  const setConsent = useCallback(
    async (granted: boolean) => {
      const patch = { consent: granted ? ("opted_in" as const) : ("opted_out" as const) };
      await rpc.request.setAnalyticsConfig(patch);
      setConfig((prev) => (prev ? { ...prev, ...patch } : null));
      if (granted && !ready) {
        const cfg = await rpc.request.getAnalyticsConfig();
        // posthog.init(cfg) goes here when posthog-js is installed
        console.debug("[analytics] consent granted", cfg.anonymous_id);
        setReady(true);
      }
    },
    [ready]
  );

  const setReplayEnabled = useCallback(
    async (enabled: boolean) => {
      await rpc.request.setAnalyticsConfig({ replay_enabled: enabled });
      setConfig((prev) => (prev ? { ...prev, replay_enabled: enabled } : null));
      // posthog.startSessionRecording() goes here when posthog-js is installed
      console.debug("[analytics] replay_enabled set to", enabled);
    },
    [ready]
  );

  return (
    <AnalyticsContext.Provider value={{ track, ready, config, setConsent, setReplayEnabled }}>
      {children}
    </AnalyticsContext.Provider>
  );
}

export function useAnalytics() {
  return useContext(AnalyticsContext);
}
