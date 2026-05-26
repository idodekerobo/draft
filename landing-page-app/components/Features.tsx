"use client";

import { useEffect, useRef } from "react";

const features = [
  {
    number: "01",
    title: "Context, always loaded",
    headline: "Stop re-explaining what you're building.",
    body: "Run /setup once. Draft interviews you and builds your structured PM brain — company context, roadmap, priorities, decisions. Every Claude Code session opens with it loaded automatically.",
    detail: "/setup · Product memory · Session context · Auto-loaded",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="4" y="6" width="20" height="16" rx="2" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M9 11h10M9 15h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="21" cy="21" r="4" fill="var(--color-bg)" stroke="var(--color-accent)" strokeWidth="1.5"/>
        <path d="M19.5 21l1 1 2-2" stroke="var(--color-accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    number: "02",
    title: "PM commands, built in",
    headline: "A full PM toolkit, one command away.",
    body: "Ask Draft to write a PRD, review your strategy, stress-test priorities, or surface what's stale. It already knows your product — grounded answers land in seconds, not meetings.",
    detail: "PRDs · Strategy reviews · Priority calls · Tradeoff analysis",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path d="M14 4C8.477 4 4 8.477 4 14s4.477 10 10 10 10-4.477 10-10S19.523 4 14 4z" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M14 9v5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M8 5.5l-2-2M20 5.5l2-2" stroke="var(--color-accent)" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    number: "03",
    title: "No more context rot",
    headline: "Claude always knows what just happened.",
    body: "Context files go stale. You ship something, change direction, drop a bet — and Claude is still reasoning from a version of your product that no longer exists. Draft logs every meaningful change in an append-only ledger. The latest decisions load in every session automatically, even when your full context files haven't been touched in weeks.",
    detail: "Append-only log · Decision ledger · Temporal drift solved · Always current",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path d="M6 14a8 8 0 0 1 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M22 14a8 8 0 0 1-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M14 6l-3-3 3-3" stroke="var(--color-accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M14 22l3 3-3 3" stroke="var(--color-accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="14" cy="14" r="2.5" fill="var(--color-accent)" opacity="0.3" stroke="var(--color-accent)" strokeWidth="1.2"/>
      </svg>
    ),
  },
];

export default function Features() {
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll(".reveal").forEach((el) => {
              el.classList.add("in-view");
            });
          }
        });
      },
      { threshold: 0.05 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      id="features"
      ref={sectionRef}
      style={{
        padding: "5rem 2rem 7rem",
        background: "var(--color-surface)",
        position: "relative",
        overflow: "hidden",
      }}
      className="blueprint-grid-faint"
    >
      {/* Top gradient fade */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "120px",
          background: "linear-gradient(to bottom, var(--color-bg), transparent)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          position: "relative",
          zIndex: 2,
        }}
      >
        {/* Header */}
        <div
          className="reveal"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "1rem",
          }}
        >
          <span className="accent-rule" style={{ width: "2rem" }} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              color: "var(--color-accent)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            What Draft does
          </span>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            marginBottom: "4rem",
            flexWrap: "wrap",
            gap: "1.5rem",
          }}
        >
          <h2
            className="reveal reveal-delay-1"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(2rem, 5vw, 3.5rem)",
              fontWeight: 500,
              letterSpacing: "-0.025em",
              lineHeight: 1.1,
              color: "var(--color-primary)",
              maxWidth: "400px",
            }}
          >
            One install. Permanent context.
          </h2>

          <p
            className="reveal reveal-delay-2"
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.95rem",
              color: "var(--color-muted)",
              lineHeight: 1.7,
              maxWidth: "340px",
            }}
          >
            Three things Draft does — and does well. No bloat, no integrations required.
          </p>
        </div>

        {/* Feature cards — 2x2 grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "1rem",
          }}
        >
          {features.map((f, i) => (
            <FeatureCard key={f.number} feature={f} delay={i + 1} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({
  feature,
  delay,
}: {
  feature: (typeof features)[0];
  delay: number;
}) {
  return (
    <div
      className={`reveal reveal-delay-${delay} glass-card`}
      style={{
        padding: "2rem",
        borderRadius: "10px",
        transition: "border-color 0.2s, transform 0.2s",
        cursor: "default",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.borderColor = "rgba(237,229,208,0.18)";
        el.style.transform = "translateY(-2px)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.borderColor = "var(--color-border)";
        el.style.transform = "translateY(0)";
      }}
    >
      {/* Number + icon row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "1.5rem",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--color-faint)",
            letterSpacing: "0.08em",
            paddingTop: "4px",
          }}
        >
          {feature.number}
        </span>
        <div style={{ color: "var(--color-muted)" }}>{feature.icon}</div>
      </div>

      {/* Title */}
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.65rem",
          color: "var(--color-accent)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          marginBottom: "0.75rem",
        }}
      >
        {feature.title}
      </div>

      {/* Headline */}
      <h3
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "1.4rem",
          fontWeight: 500,
          letterSpacing: "-0.02em",
          lineHeight: 1.25,
          color: "var(--color-primary)",
          marginBottom: "0.875rem",
        }}
      >
        {feature.headline}
      </h3>

      {/* Body */}
      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "0.875rem",
          color: "var(--color-muted)",
          lineHeight: 1.7,
          marginBottom: "1.5rem",
        }}
      >
        {feature.body}
      </p>

      {/* Detail tag */}
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.65rem",
          color: "var(--color-faint)",
          lineHeight: 1.6,
          borderTop: "1px solid var(--color-border)",
          paddingTop: "1rem",
        }}
      >
        {feature.detail}
      </div>
    </div>
  );
}
