"use client";

import { useEffect, useRef } from "react";

const steps = [
  {
    step: "01",
    title: "Install Draft",
    body: "Download the macOS desktop app. It installs as a tray icon, registers as a LaunchAgent (starts at login), and wires the plugin into your agent tools automatically.",
    tag: "Desktop app · CLI · Plugin",
  },
  {
    step: "02",
    title: "Run /draft:setup",
    body: "A short interview — what you're building, your priorities, your team. Takes 5 minutes. Writes structured context files to your workspace. This is your workspace — the source of truth that loads in every session.",
    tag: "One-time setup",
  },
  {
    step: "03",
    title: "Connect your tools",
    body: "Link Granola, Slack, and GitHub. The daemon starts capturing meeting notes, threads, and PR activity on a schedule — no manual effort.",
    tag: "Granola · Slack · GitHub",
  },
  {
    step: "04",
    title: "Review & publish",
    body: "Proposed context updates land in your inbox. Accept what's relevant. Publish to a GitHub repo your team pulls from — everyone's sessions start grounded.",
    tag: "Proposals inbox · Team sync",
  },
];

export default function HowItWorks() {
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
      { threshold: 0.1 }
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      id="how-it-works"
      ref={sectionRef}
      style={{
        padding: "7rem 2rem",
        maxWidth: "1200px",
        margin: "0 auto",
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
          How it works
        </span>
      </div>

      <h2
        className="reveal reveal-delay-1"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(2rem, 5vw, 3.5rem)",
          fontWeight: 500,
          letterSpacing: "-0.025em",
          lineHeight: 1.1,
          color: "var(--color-primary)",
          marginBottom: "5rem",
          maxWidth: "520px",
        }}
      >
        Install once.
        <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
          {" "}Your workspace, everywhere.
        </span>
      </h2>

      {/* Steps — 2×2 grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: "0",
        }}
        className="how-it-works-grid"
      >
        {steps.map((s, i) => {
          const isLeft = i % 2 === 0;
          const isTop = i < 2;
          return (
            <div
              key={s.step}
              className={`reveal reveal-delay-${i + 1}`}
              style={{
                padding: "2.5rem",
                borderRight: isLeft ? "1px solid var(--color-border)" : "none",
                borderBottom: isTop ? "1px solid var(--color-border)" : "none",
                position: "relative",
              }}
            >
              {/* Step dot */}
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "50%",
                  border: `1px solid ${i === 0 ? "var(--color-accent)" : "var(--color-border-md)"}`,
                  background: i === 0 ? "rgba(200,148,59,0.1)" : "var(--color-bg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: "1.75rem",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.65rem",
                    color: i === 0 ? "var(--color-accent)" : "var(--color-muted)",
                    letterSpacing: "0.04em",
                  }}
                >
                  {s.step}
                </span>
              </div>

              <h3
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1.25rem",
                  fontWeight: 500,
                  letterSpacing: "-0.02em",
                  color: "var(--color-primary)",
                  marginBottom: "0.75rem",
                  lineHeight: 1.3,
                }}
              >
                {s.title}
              </h3>

              <p
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.875rem",
                  color: "var(--color-muted)",
                  lineHeight: 1.7,
                  marginBottom: "1.25rem",
                }}
              >
                {s.body}
              </p>

              {/* Tag */}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  padding: "0.25rem 0.65rem",
                  background: "rgba(200,148,59,0.06)",
                  border: "1px solid rgba(200,148,59,0.18)",
                  borderRadius: "100px",
                }}
              >
                <span
                  style={{
                    width: "4px",
                    height: "4px",
                    borderRadius: "50%",
                    background: "var(--color-accent)",
                    display: "inline-block",
                    opacity: 0.6,
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    color: "var(--color-accent)",
                    letterSpacing: "0.05em",
                    opacity: 0.8,
                  }}
                >
                  {s.tag}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <style>{`
        @media (max-width: 640px) {
          .how-it-works-grid {
            grid-template-columns: 1fr !important;
          }
          .how-it-works-grid > div {
            border-right: none !important;
            border-bottom: 1px solid var(--color-border) !important;
          }
          .how-it-works-grid > div:last-child {
            border-bottom: none !important;
          }
        }
      `}</style>
    </section>
  );
}
