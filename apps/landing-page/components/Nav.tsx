"use client";

import Link from "next/link";

import { ArrowUpRight, Github } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import DraftLogo from "@/components/DraftLogo";
import ThemeToggle from "@/components/ThemeToggle";
import { openWaitlistModal } from "@/components/WaitlistModal";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";
const GITHUB_URL = "https://github.com/idodekerobo/draft";

export default function Nav({ showWaitlist = true }: { showWaitlist?: boolean }) {
  const ph = usePostHog();
  const trackLink = (label: string) => ph?.capture(EVENTS.NAV_LINK_CLICKED, { source: "nav", label });
  return (
    <header className="minimal-nav minimal-shell">
      <DraftLogo href="/" />
      <nav aria-label="Main navigation">
        <Link className="minimal-feature-link" href="/#features" onClick={() => trackLink("Features")}>Features</Link>
        <a className="minimal-github-link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label="Draft on GitHub" onClick={() => ph?.capture(EVENTS.GITHUB_CLICKED, { source: "nav" })}><Github size={18} strokeWidth={1.5} aria-hidden="true" /></a>
        <a href={`${APP_URL}/login`} onClick={() => trackLink("Sign in")}>Sign in <ArrowUpRight size={14} aria-hidden="true" /></a>
        <ThemeToggle />
        {showWaitlist && <button type="button" className="minimal-button minimal-nav-cta" onClick={() => {
          ph?.capture(EVENTS.CTA_CLICKED, { source: "nav", cta_text: "Join the waitlist" });
          openWaitlistModal("nav");
        }}>Join the waitlist</button>}
      </nav>
    </header>
  );
}
