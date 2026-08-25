"use client";

import { useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const DOWNLOAD_URL =
  "https://github.com/idodekerobo/draft/releases/latest/download/stable-macos-arm64-Draft.dmg";
const GITHUB_URL = "https://github.com/idodekerobo/draft";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";

export default function CTASection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const ph = usePostHog();

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
      { threshold: 0.2 }
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      style={{
        padding: "7rem 2rem",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Background accent */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(200,148,59,0.05), transparent 70%)",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          maxWidth: "720px",
          margin: "0 auto",
          textAlign: "center",
          position: "relative",
          zIndex: 1,
        }}
      >
        {/* Decorative mark */}
        <div
          className="reveal"
          style={{ marginBottom: "2rem", display: "flex", justifyContent: "center" }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              border: "1px solid var(--color-border-md)",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1.25rem",
                color: "var(--color-accent)",
                fontStyle: "italic",
              }}
            >
              D
            </span>
          </div>
        </div>

        <h2
          className="reveal reveal-delay-1"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(2.5rem, 7vw, 5.5rem)",
            fontWeight: 500,
            letterSpacing: "-0.03em",
            lineHeight: 1.0,
            color: "var(--color-primary)",
            marginBottom: "1.5rem",
          }}
        >
          Your company,
          <br />
          <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
            available to every agent.
          </span>
        </h2>

        <p
          className="reveal reveal-delay-2"
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "1.05rem",
            color: "var(--color-muted)",
            lineHeight: 1.7,
            maxWidth: "480px",
            margin: "0 auto 3rem",
          }}
        >
          Draft keeps your team&apos;s decisions, priorities, and working context current — then makes them available wherever your agents work.
        </p>

        <div
          className="reveal reveal-delay-3"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            flexWrap: "wrap",
          }}
        >
          <a href={`${APP_URL}/signup`} style={{ display: "inline-flex", padding: "1rem 2rem", border: "1px solid var(--color-accent)", borderRadius: "8px", color: "var(--color-accent)", textDecoration: "none", fontWeight: 700 }}>Get Started</a>
          <a
            href={DOWNLOAD_URL}
            onClick={() => ph?.capture(EVENTS.DOWNLOAD_CLICKED, { source: "cta_section" })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "1rem 2.25rem",
              background: "var(--color-accent)",
              color: "#0B0B0B",
              fontFamily: "var(--font-body)",
              fontSize: "1rem",
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
              el.style.boxShadow = "0 12px 40px rgba(200,148,59,0.3)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.opacity = "1";
              el.style.transform = "translateY(0)";
              el.style.boxShadow = "none";
            }}
          >
            <svg width="14" height="14" viewBox="0 0 814 1000" fill="currentColor" aria-hidden="true">
              <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-155.5-127.4C46.7 790.7 0 663 0 541.8c0-207.5 135.4-317.1 269-317.1 71 0 130.5 46.4 175 46.4 42.5 0 109.2-49.9 190.5-49.9zm-174.9-41.6c-31.1-36.9-53.3-88.1-53.3-139.3 0-7.1.6-14.3 1.9-20.1 50.6 1.9 110.4 33.7 147.1 75.8 28.5 32.4 55.1 83.6 55.1 135.5 0 7.8-1.3 15.5-1.9 18.1-3.2.6-8.4 1.3-13.6 1.3-45.4 0-102.5-30.4-135.3-71.3z"/>
            </svg>
            Download the desktop app
          </a>

          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => ph?.capture(EVENTS.GITHUB_CLICKED, { source: "cta_section" })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
              padding: "1rem 1.75rem",
              background: "transparent",
              color: "var(--color-primary)",
              fontFamily: "var(--font-body)",
              fontSize: "1rem",
              fontWeight: 500,
              textDecoration: "none",
              borderRadius: "8px",
              border: "1px solid var(--color-border-md)",
              transition: "border-color 0.2s, background 0.2s",
              letterSpacing: "0.01em",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = "rgba(237,229,208,0.3)";
              el.style.background = "rgba(237,229,208,0.04)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = "var(--color-border-md)";
              el.style.background = "transparent";
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
            View the Source Code
          </a>
        </div>

        {/* Fine print */}
        <p
          className="reveal reveal-delay-4"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--color-faint)",
            marginTop: "1.5rem",
            letterSpacing: "0.04em",
          }}
        >
          Hosted or self-hosted · Open source · Human-reviewed updates
        </p>
      </div>
    </section>
  );
}
