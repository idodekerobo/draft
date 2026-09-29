"use client";

import { useEffect } from "react";
import type { SharedEventName } from "draft-shared-ui";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";

/** For server pages that need one event with no props. */
export function TrackOnMount({ event }: { event: Extract<SharedEventName, "invite_viewed"> }) {
  const { track } = useAnalytics();
  useEffect(() => { track(event, {}); }, [event, track]);
  return null;
}
