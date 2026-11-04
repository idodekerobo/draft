"use client";

import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { OrbComposing } from "@/components/ui/thinking-orb";
import { EVENTS } from "@/lib/analytics";
import { APP_URL } from "@/lib/config";

type Variant = "download" | "join";

// Both pages send people to the web app, which signs them up and sets up their company.
// `src` tells it which page they came from.
const VARIANTS = {
  download: {
    heading: "Download Draft",
    lede: "Shared context for your team and your AI agents. Create your account and set up your company first, then get the app.",
    cta: "Download for Mac",
    note: "Apple Silicon Macs only (M1 or later). Intel Macs and Windows are not supported yet.",
  },
  join: {
    heading: "Get started with Draft",
    lede: "Shared context for your team and your AI agents. Create your account and set up your company in a few minutes.",
    cta: "Get Started",
    note: null,
  },
} as const satisfies Record<Variant, { heading: string; lede: string; cta: string; note: string | null }>;

export default function SignupHero({ variant }: { variant: Variant }) {
  const ph = usePostHog();
  const { heading, lede, cta, note } = VARIANTS[variant];

  useEffect(() => {
    ph?.capture(variant === "download" ? EVENTS.DOWNLOAD_PAGE_VIEWED : EVENTS.JOIN_PAGE_VIEWED);
  }, [ph, variant]);

  function onClick() {
    if (variant === "download") ph?.capture(EVENTS.DOWNLOAD_CLICKED, { source: "download_page" });
    else ph?.capture(EVENTS.CTA_CLICKED, { source: "join_page", cta_text: cta });
  }

  return (
    <main className="signup-hero-page">
      <Nav showWaitlist={false} />
      <section className="signup-hero-body" aria-labelledby="signup-hero-title">
        <div className="signup-hero-orb" aria-hidden="true">
          <OrbComposing size={380} scale={0.94} speed={0.65} pointerFollow style={{ width: "100%", height: "auto", aspectRatio: "1" }} />
        </div>
        <h1 id="signup-hero-title">{heading}</h1>
        <p className="signup-hero-lede">{lede}</p>
        <a className="minimal-button signup-hero-cta" href={`${APP_URL}/signup?src=${variant}`} onClick={onClick}>
          {cta} <span aria-hidden="true">↗</span>
        </a>
        {note && <p className="signup-hero-note">{note}</p>}
      </section>
      <Footer />
    </main>
  );
}
