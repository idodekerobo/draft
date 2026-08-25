"use client";

import { useEffect, useRef } from "react";

const features = [
  {
    number: "01",
    title: "Find the detail",
    headline: "Search the company's memory.",
    body: "Ask for a decision, customer insight, prior feedback, or the reasoning behind a priority. Draft searches your connected company context and finds the relevant detail.",
    detail: "Decisions · Customer insight · Feedback · Rationale",
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
    title: "Ground the answer",
    headline: "Give agents the context around the fact.",
    body: "A useful answer needs more than an isolated note. Draft brings back the surrounding decision, feedback, and rationale so agents can use changing details in the right way.",
    detail: "Relevant context · Connected sources · Agent sessions",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <circle cx="8" cy="14" r="3.5" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="20" cy="14" r="3.5" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="14" cy="7" r="3.5" stroke="var(--color-accent)" strokeWidth="1.5"/>
        <path d="M11.5 14H16.5" stroke="var(--color-border-md)" strokeWidth="1.2" strokeDasharray="2 1.5"/>
        <path d="M10.5 11.5L14 9.5M17.5 11.5L14 9.5" stroke="var(--color-border-md)" strokeWidth="1.2" strokeDasharray="2 1.5"/>
      </svg>
    ),
  },
  {
    number: "03",
    title: "Keep it current",
    headline: "New details become proposed updates.",
    body: "New feedback, decisions, and exceptions become proposed updates. Review what changed, accept what matters, and keep the shared context trustworthy.",
    detail: "Meetings · Slack · GitHub · Linear · Proposals inbox",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <circle cx="14" cy="14" r="9" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M14 9v5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M5 14a9 9 0 0 1 9-9" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 2"/>
        <path d="M8.5 5.5 L6 4 L5.5 7" stroke="var(--color-accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
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
          style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}
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
            Company memory
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
              maxWidth: "420px",
            }}
          >
            Find the details that{" "}
            <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
              move the work.
            </span>
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
            Search decisions, feedback, and customer insight. Review what changed. Give every agent the latest context.
          </p>
        </div>

        {/* Feature cards */}
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
