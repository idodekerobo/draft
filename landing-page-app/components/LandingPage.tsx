"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { openWaitlistModal } from "@/components/WaitlistModal";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";
const GITHUB_URL = "https://github.com/idodekerobo/draft";
type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];

function PrimaryCTA({ source, label = "Join the beta" }: { source: string; label?: string }) {
  const ph = usePostHog();

  return (
    <button
      type="button"
      className="landing-button landing-button-primary"
      onClick={() => {
        ph?.capture(EVENTS.CTA_CLICKED, { source, cta_text: label });
        openWaitlistModal(source);
      }}
    >
      {label}
      <span aria-hidden="true">↗</span>
    </button>
  );
}

function TrackedLink({
  href,
  children,
  label,
  source,
  className,
  ariaLabel,
}: {
  href: string;
  children: ReactNode;
  label: string;
  source: string;
  className?: string;
  ariaLabel?: string;
}) {
  const ph = usePostHog();

  return (
    <a
      className={className}
      href={href}
      aria-label={ariaLabel}
      onClick={() => ph?.capture(EVENTS.NAV_LINK_CLICKED, { source, label })}
    >
      {children}
    </a>
  );
}

function ArrowLink({
  href,
  children,
  external = false,
  track,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
  track?: { event: AnalyticsEvent; properties?: Record<string, string> };
}) {
  const ph = usePostHog();

  return (
    <a
      className="landing-arrow-link"
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      onClick={track ? () => ph?.capture(track.event, track.properties) : undefined}
    >
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function GitHubNavLink({ source }: { source: string }) {
  const ph = usePostHog();

  return (
    <a
      className="landing-nav-github"
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View Draft on GitHub"
      title="View Draft on GitHub — Open Source"
      onClick={() => ph?.capture(EVENTS.GITHUB_CLICKED, { source })}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
      </svg>
      <span>GitHub</span>
    </a>
  );
}

function SiteNav() {
  return (
    <header className="landing-nav">
      <div className="landing-shell landing-nav-inner">
        <TrackedLink className="landing-logo" href="#top" label="Draft home" source="nav" ariaLabel="Draft home">
          Draft<span>.</span>
        </TrackedLink>
        <nav className="landing-nav-links" aria-label="Main navigation">
          <TrackedLink href="#for-who" label="Who it's for" source="nav">Who it&apos;s for</TrackedLink>
          <TrackedLink href="#features" label="Why Draft" source="nav">Why Draft</TrackedLink>
          <TrackedLink href="#how-it-works" label="How it works" source="nav">How it works</TrackedLink>
          <TrackedLink href={`${APP_URL}/login`} label="Sign in" source="nav">Sign in</TrackedLink>
          <GitHubNavLink source="nav" />
          <PrimaryCTA source="nav" />
        </nav>
        <div className="landing-nav-mobile-actions">
          <TrackedLink href={`${APP_URL}/login`} label="Sign in" source="nav_mobile" ariaLabel="Sign in">Sign in</TrackedLink>
          <GitHubNavLink source="nav_mobile" />
          <PrimaryCTA source="nav_mobile" />
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="landing-hero">
      <div className="landing-shell landing-hero-grid">
        <div className="landing-hero-copy">
          <p className="landing-kicker landing-reveal">The company brain for AI-native teams</p>
          <h1 className="landing-display landing-reveal landing-reveal-delay-1">
            One company brain. Every agent in sync.
          </h1>
          <p className="landing-hero-lede landing-reveal landing-reveal-delay-2">
            Draft turns the decisions, customer context, and priorities scattered across your work into one company brain. Browse it yourself in Draft, or let every agent query that same brain mid-session—so Claude Code, Codex, Cursor, and more stop drifting apart.
          </p>
          <p className="landing-hero-access landing-reveal landing-reveal-delay-2">
            <span>People</span> browse it in Draft <i /> <span>Agents</span> query the same brain mid-session
          </p>
          <div className="landing-hero-actions landing-reveal landing-reveal-delay-3">
            <PrimaryCTA source="hero" />
            <ArrowLink
              href="#how-it-works"
              track={{ event: EVENTS.NAV_LINK_CLICKED, properties: { source: "hero", label: "See how it works" } }}
            >
              See how it works
            </ArrowLink>
          </div>
          <p className="landing-hero-note landing-reveal landing-reveal-delay-3">
            For teams already running Claude Code, Codex, Cursor, and more across their work.
          </p>
        </div>

        <figure className="landing-signal-field landing-reveal landing-reveal-delay-2">
          <div className="landing-signal-traces" aria-hidden="true" />
          <div className="landing-source-strip" aria-label="Signals feeding Draft from GitHub, Granola, and Slack">
            <span className="landing-source-strip-label">Signals in</span>
            <div className="landing-source-strip-row">
              <div className="landing-source-card">
                <Image src="/github-screenshot.png" alt="GitHub activity" width={2698} height={1792} unoptimized />
                <span>GitHub</span>
              </div>
              <div className="landing-source-card">
                <Image src="/granola-screenshot.png" alt="Granola meeting notes" width={2430} height={1690} unoptimized />
                <span>Granola</span>
              </div>
              <div className="landing-source-card">
                <Image src="/slack-screenshot.png" alt="Slack conversations" width={2768} height={1818} unoptimized />
                <span>Slack</span>
              </div>
            </div>
            <span className="landing-source-strip-more">and more</span>
          </div>
          <div className="landing-context-shot">
            <span className="landing-context-label">Draft / Company context</span>
            <Image
              src="/context-screenshot.png"
              alt="Draft company context showing current priorities and source metadata"
              width={2294}
              height={1560}
              priority
              sizes="(max-width: 900px) 88vw, 48vw"
              unoptimized
            />
          </div>
          <figcaption>
            <span>Many signals</span>
            <strong>→ one company brain → people + agents</strong>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function ContextProblem() {
  return (
    <section className="landing-problem" aria-label="The context problem">
      <div className="landing-shell">
        <p className="landing-kicker">The context gap</p>
        <div className="landing-problem-grid">
          <h2 className="landing-display">Your agents are moving fast. They just don&apos;t share a brain.</h2>
          <p>
            One agent sees the latest Slack decision. Another works from an old doc. A third asks you to explain it again. Without one shared company brain, agents contradict each other, redo work, and leave you guessing which answer is current.
          </p>
        </div>
        <div className="landing-problem-points">
          <div><strong>01</strong><span>Different agents answer from different context.</span></div>
          <div><strong>02</strong><span>The same work gets redone in parallel.</span></div>
          <div><strong>03</strong><span>No one can tell which answer is current.</span></div>
        </div>
      </div>
    </section>
  );
}

function ForWho() {
  return (
    <section id="for-who" className="landing-section landing-audience">
      <div className="landing-shell">
        <div className="landing-section-intro">
          <p className="landing-kicker">Built for the people carrying the context</p>
          <h2 className="landing-display">If your team runs multiple agents, Draft is for you.</h2>
        </div>
        <div className="landing-audience-list">
          <article>
            <span className="landing-index">01</span>
            <div>
              <h3>Founders running agents across the company</h3>
              <p>With Claude Code, Codex, Cursor, and more helping across the work, keep the company brain somewhere you can see it—and stop being the person every agent depends on for context.</p>
              <span className="landing-audience-outcome">Stay out of the relay loop.</span>
            </div>
          </article>
          <article>
            <span className="landing-index">02</span>
            <div>
              <h3>Product teams building with AI</h3>
              <p>Run several agents in parallel without losing track of which one has the latest priorities, customer feedback, or product decisions. Your team can browse the brain; every agent can query it.</p>
              <span className="landing-audience-outcome">Keep every agent aligned.</span>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function Integrations() {
  return (
    <section id="integrations" className="landing-integrations">
      <div className="landing-shell landing-integrations-inner">
        <span>Connect the signals already shaping the work</span>
        <div className="landing-source-list" aria-label="Supported sources">
          <span>Meetings</span><i />
          <span>Slack</span><i />
          <span>GitHub</span><i />
          <span>Linear</span><i />
          <span>Agent sessions</span><i />
          <span>and more</span>
        </div>
      </div>
    </section>
  );
}

function Features() {
  const features = [
    ["Find", "Browse the decision, customer insight, or rationale yourself—or have an agent retrieve it mid-session through MCP or CLI."],
    ["Ground", "Every agent pulls from the same grounded context you can see in Draft, across meetings, Slack, GitHub, Granola, Linear, and more."],
    ["Keep current", "Update the company brain once. People and every connected agent see the same current decisions, feedback, and priorities."],
  ];

  return (
    <section id="features" className="landing-section landing-features">
      <div className="landing-shell">
        <div className="landing-section-intro landing-features-intro">
          <p className="landing-kicker">Why Draft</p>
          <h2 className="landing-display">One company brain. Two front doors.</h2>
          <p>Draft turns the signals your company creates every day into one current company brain—viewable by your team in Draft and queryable by every connected agent.</p>
        </div>
        <div className="landing-feature-list">
          {features.map(([title, body], index) => (
            <article key={title}>
              <span className="landing-index">0{index + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
              <span className="landing-feature-mark" aria-hidden="true">↗</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    ["Start with your company brain", "Add your product context, priorities, team, and decisions. Browse the full context directly in Draft whenever you need it."],
    ["Connect the signals", "Bring in GitHub, Granola, Slack, Linear, meetings, agent sessions, and more."],
    ["Synthesize what changed", "Draft turns new decisions, feedback, and priorities into current company context as the work moves."],
    ["Enable every agent", "Connect Claude Code, Codex, Cursor, and every agent your company uses through MCP or CLI. Each one retrieves from the same company brain your team can open and browse in Draft."],
  ];

  return (
    <section id="how-it-works" className="landing-section landing-how-it-works">
      <div className="landing-shell">
        <div className="landing-section-intro">
          <p className="landing-kicker">How it works</p>
          <h2 className="landing-display">Set it up once. Give your team and every agent the same company brain.</h2>
        </div>
        <div className="landing-steps">
          {steps.map(([title, body], index) => (
            <article key={title}>
              <span className="landing-step-number">0{index + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
              <span className="landing-step-arrow" aria-hidden="true">→</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="landing-final-cta">
      <div className="landing-shell landing-final-cta-inner">
        <div>
          <p className="landing-kicker">Ready when you are</p>
          <h2 className="landing-display">One company brain. Viewable by your team. Queryable by every agent.</h2>
        </div>
        <div className="landing-final-cta-action">
          <PrimaryCTA source="final_cta" label="Get on the list" />
          <p>No spam. Just beta updates.</p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="landing-footer">
      <div className="landing-shell landing-footer-top">
        <div>
          <TrackedLink className="landing-logo" href="#top" label="Draft home" source="footer">Draft<span>.</span></TrackedLink>
          <p>The company brain for teams building with AI.</p>
        </div>
        <div className="landing-footer-links">
          <div>
            <span>Product</span>
            <TrackedLink href="#for-who" label="Who it's for" source="footer">Who it&apos;s for</TrackedLink>
            <TrackedLink href="#features" label="Why Draft" source="footer">Why Draft</TrackedLink>
            <TrackedLink href="#how-it-works" label="How it works" source="footer">How it works</TrackedLink>
          </div>
          <div>
            <span>More</span>
            <ArrowLink href={GITHUB_URL} external track={{ event: EVENTS.GITHUB_CLICKED, properties: { source: "footer" } }}>View on GitHub</ArrowLink>
            <TrackedLink href="/support" label="Support" source="footer">Support</TrackedLink>
          </div>
        </div>
      </div>
      <div className="landing-shell landing-footer-bottom">
        <span>© {new Date().getFullYear()} Draft</span>
        <div>
          <TrackedLink href="/privacy-policy" label="Privacy" source="footer">Privacy</TrackedLink>
          <TrackedLink href="/terms" label="Terms" source="footer">Terms</TrackedLink>
        </div>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  return (
    <main className="landing-page">
      <SiteNav />
      <Hero />
      <ContextProblem />
      <ForWho />
      <Integrations />
      <Features />
      <HowItWorks />
      <FinalCTA />
      <Footer />
    </main>
  );
}
