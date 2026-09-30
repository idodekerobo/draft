"use client";

// posthog-js is imported only here, and lazily. No key means analytics no-ops, as on OSS desktop builds.
import type { PostHog } from "posthog-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { PLATFORM_PROPERTY, type TrackFn } from "draft-shared-ui";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const MAX_PENDING = 100;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

interface AnalyticsUser {
  id: string;
  analytics_consent: boolean | null;
  session_replay_enabled: boolean;
}

interface AnalyticsValue {
  track: TrackFn;
  /** Match PostHog to the user's stored choice. */
  syncUser: (user: AnalyticsUser | null) => void;
}

const AnalyticsContext = createContext<AnalyticsValue>({ track: () => {}, syncUser: () => {} });

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const posthogRef = useRef<PostHog | null>(null);
  const initialized = useRef(false);
  const optedIn = useRef(false);
  // Events before consent wait here. They are sent only if consent is granted
  // in this tab, and dropped on opt-out.
  const pending = useRef<Array<[string, Record<string, unknown>]>>([]);
  // Child effects run first, so the user can arrive before init; apply it after.
  const latestUser = useRef<AnalyticsUser | null>(null);

  useEffect(() => {
    if (!POSTHOG_KEY || initialized.current) return;
    void import("posthog-js").then(({ default: posthog }) => {
      if (initialized.current) return;
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        autocapture: false,
        capture_pageview: false,
        opt_out_capturing_by_default: true,
        persistence: "localStorage",
        disable_session_recording: true,
        session_recording: { maskAllInputs: true, maskTextSelector: "*" },
      });
      posthog.register({ [PLATFORM_PROPERTY]: "web" });
      posthogRef.current = posthog;
      initialized.current = true;
      applyUser(latestUser.current);
    });
  }, []);

  const track = useCallback(((event, props) => {
    if (!POSTHOG_KEY) return;
    if (optedIn.current) posthogRef.current?.capture(event, props);
    else if (pending.current.length < MAX_PENDING) pending.current.push([event, props]);
  }) as TrackFn, []);

  const applyUser = useCallback((user: AnalyticsUser | null) => {
    const posthog = posthogRef.current;
    if (!POSTHOG_KEY || !posthog) return;
    if (user?.analytics_consent === true) {
      if (!optedIn.current) {
        posthog.opt_in_capturing();
        posthog.identify(user.id);
        optedIn.current = true;
        for (const [event, props] of pending.current) posthog.capture(event, props);
        pending.current = [];
      }
      if (user.session_replay_enabled) posthog.startSessionRecording();
      else posthog.stopSessionRecording();
      return;
    }
    pending.current = [];
    if (optedIn.current) {
      posthog.stopSessionRecording();
      posthog.opt_out_capturing();
      posthog.reset();
      optedIn.current = false;
    }
  }, []);

  const syncUser = useCallback((user: AnalyticsUser | null) => {
    latestUser.current = user;
    applyUser(user);
  }, [applyUser]);

  const value = useMemo(() => ({ track, syncUser }), [track, syncUser]);
  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalytics(): AnalyticsValue {
  return useContext(AnalyticsContext);
}
