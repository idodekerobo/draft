"use client";

import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const DOWNLOAD_URL =
  "https://github.com/idodekerobo/draft/releases/latest/download/stable-macos-arm64-Draft.dmg";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";

const BULLETS = [
  {
    label: "Find.",
    text: "Ask for a decision, customer insight, prior feedback, or rationale.",
  },
  {
    label: "Remember.",
    text: "Synthesize meetings, Slack threads, and activity into durable company memory.",
  },
  {
    label: "Unblock.",
    text: "Let teammates and agents self-serve instead of interrupting the person who knows.",
  },
];

export default function DemoHeroLeft() {
  const ph = usePostHog();
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Headline */}
      <h1
        className="animate-fade-up delay-100"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(2.6rem, 4.5vw, 4.25rem)",
          fontWeight: 500,
          lineHeight: 1.0,
          letterSpacing: "-0.03em",
          color: "var(--color-primary)",
          margin: "0 0 1.25rem 0",
        }}
      >
        A company brain
        <br />
        for founders and
        <br />
        <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
          AI-native teams.
        </span>
      </h1>

      {/* Positioning line */}
      <p
        className="animate-fade-up delay-200"
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "1.1rem",
          fontWeight: 600,
          color: "var(--color-primary)",
          margin: "0 0 1.25rem 0",
        }}
      >
        Give your agents more than a CLAUDE.md file.
      </p>

      {/* Subhead */}
      <p
        className="animate-fade-up delay-300"
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "1rem",
          color: "var(--color-muted)",
          lineHeight: 1.7,
          marginBottom: "2rem",
          maxWidth: "400px",
        }}
      >
        Draft synthesizes the decisions, feedback, customer details, and
        rationale that change week to week, so {" "}
        <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
          teammates and agents
        </span>{" "}
        can find what they need without waiting on the person who knows.
      </p>

      {/* Bullets */}
      <div
        className="animate-fade-up delay-300"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          marginBottom: "2.25rem",
        }}
      >
        {BULLETS.map((b, i) => (
          <div key={i} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}>
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.8rem",
                fontWeight: 600,
                fontStyle: "italic",
                color: "var(--color-accent)",
                flexShrink: 0,
                marginTop: "1px",
                minWidth: "60px",
              }}
            >
              {b.label}
            </span>
            <span
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.875rem",
                color: "var(--color-muted)",
                lineHeight: 1.55,
              }}
            >
              {b.text}
            </span>
          </div>
        ))}
      </div>

      {/* CTAs */}
      <div
        className="animate-fade-up delay-400"
        style={{ display: "flex", flexDirection: "column", gap: "0.625rem", alignItems: "flex-start" }}
      >
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <a
            href={`${APP_URL}/signup`}
            onClick={() => ph?.capture(EVENTS.CTA_CLICKED, { source: "hero", cta_text: "Get Started" })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.875rem 1.75rem",
              background: "var(--color-accent)",
              color: "#0B0B0B",
              fontFamily: "var(--font-body)",
              fontSize: "0.9rem",
              fontWeight: 700,
              textDecoration: "none",
              borderRadius: "8px",
              transition: "opacity 0.2s, transform 0.2s, box-shadow 0.2s",
              letterSpacing: "0.01em",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.opacity = "0.9";
              el.style.transform = "translateY(-2px)";
              el.style.boxShadow = "0 6px 24px rgba(168,110,32,0.22)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.opacity = "1";
              el.style.transform = "translateY(0)";
              el.style.boxShadow = "none";
            }}
          >
            Get Started
          </a>

          <a
            href={DOWNLOAD_URL}
            onClick={() => ph?.capture(EVENTS.DOWNLOAD_CLICKED, { source: "hero" })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.875rem 1.75rem",
              background: "transparent",
              color: "var(--color-primary)",
              fontFamily: "var(--font-body)",
              fontSize: "0.9rem",
              fontWeight: 600,
              textDecoration: "none",
              borderRadius: "8px",
              border: "1px solid var(--color-border-md)",
              transition: "border-color 0.2s, background 0.2s, transform 0.2s",
              letterSpacing: "0.01em",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = "rgba(237,229,208,0.3)";
              el.style.background = "rgba(237,229,208,0.04)";
              el.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = "var(--color-border-md)";
              el.style.background = "transparent";
              el.style.transform = "translateY(0)";
            }}
          >
            Download the desktop app
          </a>
        </div>
      </div>

    </div>
  );
}
