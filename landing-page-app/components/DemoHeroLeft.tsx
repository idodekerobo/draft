"use client";

import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const GITHUB_URL = "https://github.com/idodekerobo/draft";
const DOWNLOAD_URL =
  "https://github.com/idodekerobo/draft/releases/latest/download/stable-macos-arm64-Draft.dmg";

const BULLETS = [
  {
    label: "Capture.",
    text: "Meetings, Slack threads, and GitHub activity synthesized into context automatically.",
  },
  {
    label: "Review.",
    text: "A proposals inbox where you control what gets added to your shared context.",
  },
  {
    label: "Inject.",
    text: "Every Claude Code, Codex, or Cursor session opens with your full context loaded.",
  },
  {
    label: "Sync.",
    text: "Publish context to a repo your team controls. Everyone starts grounded.",
  },
];

export default function DemoHeroLeft() {
  const ph = usePostHog();
  const downloadCta = "Download for macOS";

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Eyebrow */}
      <div
        className="animate-fade-in delay-100"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.35rem 0.875rem",
          border: "1px solid var(--color-border-md)",
          borderRadius: "100px",
          marginBottom: "2rem",
          alignSelf: "flex-start",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--color-accent)",
            display: "inline-block",
            animation: "heroLeftPulse 2s ease-in-out infinite",
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            color: "var(--color-muted)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          macOS · Apple Silicon · Free & Open Source
        </span>
      </div>

      {/* Headline */}
      <h1
        className="animate-fade-up delay-200"
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
        Your team&rsquo;s agent
        <br />
        sessions,{" "}
        <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
          always grounded.
        </span>
      </h1>

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
        Draft runs in the background, capturing context from your meetings,
        Slack, and GitHub — then injects it automatically at the start of every
        agent session. No re-explaining. No copy-pasting.
      </p>

      {/* Bullets */}
      <div
        className="animate-fade-up delay-400"
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
        className="animate-fade-up delay-500"
        style={{ display: "flex", flexDirection: "column", gap: "0.625rem", alignItems: "flex-start" }}
      >
        <a
          href={DOWNLOAD_URL}
          onClick={() =>
            ph?.capture(EVENTS.CTA_CLICKED, { cta_location: "hero", cta_text: downloadCta })
          }
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
          {/* Apple icon */}
          <svg width="13" height="13" viewBox="0 0 814 1000" fill="currentColor" aria-hidden="true">
            <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-155.5-127.4C46.7 790.7 0 663 0 541.8c0-207.5 135.4-317.1 269-317.1 71 0 130.5 46.4 175 46.4 42.5 0 109.2-49.9 190.5-49.9zm-174.9-41.6c-31.1-36.9-53.3-88.1-53.3-139.3 0-7.1.6-14.3 1.9-20.1 50.6 1.9 110.4 33.7 147.1 75.8 28.5 32.4 55.1 83.6 55.1 135.5 0 7.8-1.3 15.5-1.9 18.1-3.2.6-8.4 1.3-13.6 1.3-45.4 0-102.5-30.4-135.3-71.3z"/>
          </svg>
          {downloadCta}
        </a>

        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.68rem",
            color: "var(--color-faint)",
            letterSpacing: "0.05em",
          }}
        >
          Free · Open source · No sign-up required
        </span>
      </div>

      <style>{`
        @keyframes heroLeftPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.45; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
}
