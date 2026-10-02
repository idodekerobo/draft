// desktop/src/app/analytics/AnalyticsContext.tsx
// PostHog is never imported outside this file — it is the single SDK boundary.
// Consent lives on the Draft account (PATCH /me/privacy), shared with web.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PostHog } from "posthog-js";
import { PLATFORM_PROPERTY } from "draft-shared-ui";
import type { PrivacyState } from "../../rpc/schema";
import type { AnalyticsEvent } from "./events";
import { rpc } from "../rpc";
import { useUserIdentity } from "../identity/UserIdentityContext";

const MAX_PENDING = 100;

interface AnalyticsContextValue {
  track: <E extends AnalyticsEvent>(
    event: E["event"],
    props: Extract<AnalyticsEvent, { event: E["event"] }>["props"]
  ) => void;
  privacy: PrivacyState | null;
  /** Usage analytics and session replay together. */
  setConsent: (granted: boolean) => Promise<void>;
}

const AnalyticsContext = createContext<AnalyticsContextValue>({
  track: () => {},
  privacy: null,
  setConsent: async () => {},
});

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const { signedIn, hydrated } = useUserIdentity();
  const [initialized, setInitialized] = useState(false);
  const [privacy, setPrivacyState] = useState<PrivacyState | null>(null);
  const posthogRef = useRef<PostHog | null>(null);
  const optedIn = useRef(false);
  const pendingRef = useRef<Array<{ event: string; props: Record<string, unknown> }>>([]);

  useEffect(() => {
    void rpc.request.getAnalyticsConfig().then(async (cfg) => {
      if (!cfg.posthog_key) return; // OSS builds or missing build-config.json — silently skip
      const { default: posthog } = await import("posthog-js");
      posthog.init(cfg.posthog_key, {
        api_host: cfg.posthog_host ?? "https://us.i.posthog.com",
        defaults: "2026-05-30",
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
        session_recording: { maskTextSelector: "*", maskAllInputs: true },
        persistence: "localStorage",
        opt_out_capturing_by_default: true,
      });
      posthog.register({ [PLATFORM_PROPERTY]: "desktop" });
      posthogRef.current = posthog;
      setInitialized(true);
    });
  }, []);

  const apply = useCallback((next: PrivacyState) => {
    setPrivacyState(next);
    const posthog = posthogRef.current;
    if (!initialized || !posthog) return;
    if (next.analyticsConsent) {
      if (!optedIn.current) {
        posthog.opt_in_capturing();
        optedIn.current = true;
        pendingRef.current.forEach(({ event, props }) => posthog.capture(event, props));
        pendingRef.current = [];
        posthog.startSessionRecording();
      }
      // User id only, never email or name. Signed out: PostHog keeps its own anonymous id.
      if (next.userId) posthog.identify(next.userId);
      return;
    }
    pendingRef.current = [];
    if (optedIn.current) {
      posthog.stopSessionRecording();
      posthog.opt_out_capturing();
      posthog.reset();
      optedIn.current = false;
    }
  }, [initialized]);

  useEffect(() => {
    if (!hydrated) return;
    void rpc.request.getPrivacy({ signedIn }).then(apply).catch(() => {});
  }, [hydrated, signedIn, apply]);

  const track = useCallback(
    (event: string, props: Record<string, unknown>) => {
      if (!optedIn.current) {
        if (pendingRef.current.length < MAX_PENDING) pendingRef.current.push({ event, props });
        return;
      }
      posthogRef.current?.capture(event, props);
    },
    []
  ) as AnalyticsContextValue["track"];

  const save = useCallback(async (patch: { analytics_consent: boolean }) => {
    const result = await rpc.request.setPrivacy(patch);
    if (!result.ok || !result.privacy) throw new Error(result.error ?? "Could not save your privacy choice.");
    apply(result.privacy);
  }, [apply]);

  const setConsent = useCallback(async (granted: boolean) => {
    await save({ analytics_consent: granted });
    if (granted && optedIn.current) posthogRef.current?.capture("analytics_consent_granted", {});
  }, [save]);

  const value = useMemo(
    () => ({ track, privacy, setConsent }),
    [track, privacy, setConsent],
  );

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
    </AnalyticsContext.Provider>
  );
}

export function useAnalytics() {
  return useContext(AnalyticsContext);
}
