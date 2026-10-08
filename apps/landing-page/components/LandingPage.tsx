"use client";

import { ArrowUpRight, Brain, Cable, RefreshCw, Search, Users, Workflow } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { openWaitlistModal } from "@/components/WaitlistModal";
import { OrbComposing } from "@/components/ui/thinking-orb";
import { FeatureCard, type Feature } from "@/components/ui/grid-feature-cards";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

const features: Feature[] = [
  { title: "One company brain", icon: Brain, description: "Your decisions, customer insights, and priorities, brought together in one place." },
  { title: "Connected to your work", icon: Cable, description: "Bring in context from Slack, GitHub, Linear, meetings, agent sessions and traces (and more)." },
  { title: "Always current", icon: RefreshCw, description: "A self-updating brain that turns new feedback and decisions into current context as your company works." },
  { title: "Answers with context", icon: Search, description: "Find the decision and the thinking behind it, without digging through old threads." },
  { title: "Every agent can connect", icon: Workflow, description: "Give Claude Code, Codex, Cursor, and more the same company brain through MCP or CLI." },
  { title: "Made for your team", icon: Users, description: "Browse and update the context yourself. Your team and agents work from the same understanding." },
];

function WaitlistButton({ source }: { source: string }) {
  const ph = usePostHog();
  return (
    <button type="button" className="minimal-button" onClick={() => {
      ph?.capture(EVENTS.CTA_CLICKED, { source, cta_text: "Join the waitlist" });
      openWaitlistModal(source);
    }}>
      Join the waitlist <ArrowUpRight size={17} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

export default function LandingPage() {
  return (
    <div className="minimal-landing" id="top">
      <Nav showWaitlist={false} />
      <section className="minimal-hero minimal-shell" aria-labelledby="hero-title">
        <div className="minimal-hero-copy">
          <h1 id="hero-title">Your company&apos;s context layer</h1>
          <p>
            <strong className="minimal-hero-helper-title">A self updating company brain</strong>
            Turn scattered decisions, customer insights, documents, and priorities into shared context and a retrieval surface for your team and every AI agent.
          </p>
          <WaitlistButton source="hero" />
        </div>
        <div className="minimal-hero-orb" aria-hidden="true">
          <OrbComposing surface="auto" size={640} scale={0.94} speed={0.65} pointerFollow style={{ width: "100%", height: "auto", aspectRatio: "1" }} />
        </div>
      </section>
      <section id="features" className="minimal-features minimal-shell" aria-labelledby="features-title">
        <div className="minimal-section-heading">
          <h2 id="features-title">Shared context. Better work.</h2>
          <p>Keep everyone building from the same understanding.</p>
        </div>
        <div className="minimal-feature-grid">
          {features.map((feature, index) => <FeatureCard key={feature.title} feature={feature} index={index} />)}
        </div>
      </section>
      <section className="minimal-final-cta minimal-shell" aria-labelledby="waitlist-heading">
        <h2 id="waitlist-heading">Your company should be self-driving.</h2>
        <p>Give your team and every agent a shared starting point.</p>
        <WaitlistButton source="final_cta" />
        <small>No spam. Just beta updates.</small>
      </section>
      <Footer />
    </div>
  );
}
