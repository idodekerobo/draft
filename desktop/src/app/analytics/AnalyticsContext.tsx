// desktop/src/app/analytics/AnalyticsContext.tsx
// PostHog is never imported outside this file — it is the single SDK boundary.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import posthog from "posthog-js";
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
  const pendingRef = useRef<Array<{ event: string; props: Record<string, unknown> }>>([]);

  useEffect(() => {
    async function init() {
      const cfg = await rpc.request.getAnalyticsConfig();
      setConfig(cfg);
      if (!cfg.posthog_key) return;
      const alreadyOptedIn = cfg.consent === "opted_in";
      _initPostHog(cfg, !alreadyOptedIn);
      if (alreadyOptedIn) setReady(true);
    }
    void init();
  }, []);

  const track = useCallback(
    (event: string, props: Record<string, unknown>) => {
      if (!ready) {
        pendingRef.current.push({ event, props });
        return;
      }
      posthog.capture(event, props);
    },
    [ready]
  ) as AnalyticsContextValue["track"];

  const setConsent = useCallback(
    async (granted: boolean) => {
      const patch = { consent: granted ? ("opted_in" as const) : ("opted_out" as const) };
      await rpc.request.setAnalyticsConfig(patch);
      setConfig((prev) => (prev ? { ...prev, ...patch } : null));
      if (granted) {
        posthog.opt_in_capturing();
        pendingRef.current.forEach(({ event, props }) => posthog.capture(event, props));
        pendingRef.current = [];
        setReady(true);
      } else {
        posthog.opt_out_capturing();
        pendingRef.current = [];
      }
    },
    []
  );

  const setReplayEnabled = useCallback(
    async (enabled: boolean) => {
      await rpc.request.setAnalyticsConfig({ replay_enabled: enabled });
      setConfig((prev) => (prev ? { ...prev, replay_enabled: enabled } : null));
      if (enabled && ready) posthog.startSessionRecording();
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

// ── Internal ─────────────────────────────────────────────────────────────────

function _initPostHog(cfg: AnalyticsConfig, optOutByDefault: boolean) {
  if (!cfg.posthog_key) return; // OSS builds or missing build-config.json — silently skip
  posthog.init(cfg.posthog_key, {
    api_host: cfg.posthog_host ?? "https://us.i.posthog.com",
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: !cfg.replay_enabled,
    session_recording: { maskTextSelector: '*', maskAllInputs: true },
    persistence: "localStorage",
    opt_out_capturing_by_default: optOutByDefault,
  });
  posthog.identify(cfg.anonymous_id); // stable anon UUID — never an email or name
}
