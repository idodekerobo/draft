"use client";

import { useState, useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "#";
const STORAGE_KEY = "draft_demo";

const GITHUB_URL = "https://github.com/idodekerobo/draft-cli-plugin";

const BULLETS = [
  {
    label: "Install.",
    text: "One command: claude plugin install draft. Free, open source, no sign-up.",
  },
  {
    label: "Setup.",
    text: "Run /setup once. Draft interviews you and builds your structured PM brain.",
  },
  {
    label: "Load.",
    text: "Every session opens with your full product context — automatically.",
  },
  {
    label: "Think.",
    text: "PRDs, strategy reviews, tradeoffs. Draft already knows your product.",
  },
];

export default function DemoHeroLeft() {
  const ph = usePostHog();
  const ctaText = "Install the plugin"

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
          For PM-Builders · Open Source
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
          marginBottom: "1.25rem",
          margin: "0 0 1.25rem 0",
        }}
      >
        The PM brain
        <br />
        <span
          style={{
            color: "var(--color-accent)",
            fontStyle: "italic",
          }}
        >
          behind Claude Code.
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
          maxWidth: "380px",
        }}
      >
        Draft gives Claude Code a persistent PM brain. Run{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-accent)", fontSize: "0.9em" }}>/setup</span>{" "}
        once — every session starts with your full product context, loaded automatically.
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
          <div
            key={i}
            style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start" }}
          >
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.8rem",
                fontWeight: 600,
                fontStyle: "italic",
                color: "var(--color-accent)",
                flexShrink: 0,
                marginTop: "1px",
                minWidth: "52px",
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

      {/* CTA */}
      <div
        className="animate-fade-up delay-500"
        style={{ display: "flex", flexDirection: "column", gap: "0.625rem", alignItems: "flex-start" }}
      >
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => ph?.capture(EVENTS.CTA_CLICKED, { cta_location: 'hero', cta_text: ctaText })}
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
          {ctaText}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 8h10M9 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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
