"use client";

import { useEffect, useRef } from "react";

const GITHUB_URL = "https://github.com/idodekerobo/draft-cli-plugin";

export default function CTASection() {
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
          style={{
            marginBottom: "2rem",
            display: "flex",
            justifyContent: "center",
          }}
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
          Your PM is always
          <br />
          <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
            on draft.
          </span>
        </h2>

        <p
          className="reveal reveal-delay-2"
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "1.05rem",
            color: "var(--color-muted)",
            lineHeight: 1.7,
            marginBottom: "3rem",
            maxWidth: "480px",
            margin: "0 auto 3rem",
          }}
        >
          Stop re-explaining your product to Claude every session. Install Draft once — your full PM context loads automatically, every time.
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
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
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
            Install the plugin
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
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
          Free · Open source · MIT License · No sign-up required
        </p>
      </div>
    </section>
  );
}
