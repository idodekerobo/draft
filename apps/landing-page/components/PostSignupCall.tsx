"use client";

import { useEffect, useState } from "react";
import Cal, { getCalApi } from "@calcom/embed-react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { getAttribution } from "@/lib/attribution";
import { trackCallBooked } from "@/lib/track";

const CAL_NAMESPACE = "learn-about-draft";
const CAL_PATH = "idode/learn-about-draft";

const READY_FALLBACK_MS = 6000;

function CalSkeleton() {
  return (
    <div className="cal-skeleton" aria-hidden="true">
      <div className="cal-skeleton-meta">
        <span className="cal-skeleton-block" style={{ width: 24, height: 24, borderRadius: "50%" }} />
        <span className="cal-skeleton-block" style={{ width: "30%", height: 12 }} />
        <span className="cal-skeleton-block" style={{ width: "55%", height: 22 }} />
        <span className="cal-skeleton-block" style={{ width: "22%", height: 12 }} />
        <span className="cal-skeleton-block" style={{ width: "28%", height: 12 }} />
      </div>
      <span className="cal-skeleton-block" style={{ width: "36%", height: 16, marginTop: 28 }} />
      <div className="cal-skeleton-grid">
        {Array.from({ length: 35 }, (_, index) => (
          <span key={index} className="cal-skeleton-block" style={{ height: 40 }} />
        ))}
      </div>
    </div>
  );
}

export function CalEmbed({ email, source }: { email: string; source: string }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let removeListeners: (() => void) | undefined;
    let cancelled = false;
    // Show the embed anyway if Cal never reports ready, so the skeleton cannot stick.
    const fallback = setTimeout(() => setReady(true), READY_FALLBACK_MS);
    getCalApi({ namespace: CAL_NAMESPACE }).then((cal) => {
      if (cancelled) return;
      const onBooked = () => trackCallBooked(source);
      const onReady = () => setReady(true);
      cal("on", { action: "bookingSuccessfulV2", callback: onBooked });
      cal("on", { action: "linkReady", callback: onReady });
      cal("on", { action: "linkFailed", callback: onReady });
      removeListeners = () => {
        cal("off", { action: "bookingSuccessfulV2", callback: onBooked });
        cal("off", { action: "linkReady", callback: onReady });
        cal("off", { action: "linkFailed", callback: onReady });
      };
    });
    return () => {
      cancelled = true;
      clearTimeout(fallback);
      removeListeners?.();
    };
  }, [source]);

  const last = getAttribution().last ?? {};
  const utm = Object.fromEntries(Object.entries(last).filter(([key]) => key.startsWith("utm_")));

  return (
    <div className="cal-embed" data-ready={ready}>
      <CalSkeleton />
      <div className="cal-embed-frame">
        <Cal
          namespace={CAL_NAMESPACE}
          calLink={CAL_PATH}
          style={{ width: "100%" }}
          config={{ layout: "month_view", email, ...utm }}
        />
      </div>
    </div>
  );
}

interface PostSignupCallProps {
  email: string;
  source: string;
  // Controlled mode: the parent owns the open state and may render the embed elsewhere.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  inlineEmbed?: boolean;
}

export default function PostSignupCall({
  email,
  source,
  open: openProp,
  onOpenChange,
  inlineEmbed = true,
}: PostSignupCallProps) {
  const ph = usePostHog();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;

  if (open) {
    return inlineEmbed ? (
      <div style={{ marginTop: "1.25rem" }}>
        <CalEmbed email={email} source={source} />
      </div>
    ) : null;
  }

  return (
    <button
      type="button"
      className="minimal-button"
      onClick={() => {
        setInternalOpen(true);
        onOpenChange?.(true);
        ph?.capture(EVENTS.CALL_EMBED_OPENED, { source });
      }}
      style={{ marginTop: "1.25rem", gap: "12px" }}
    >
      Skip the wait: book a call
      <span aria-hidden="true">↗</span>
    </button>
  );
}
