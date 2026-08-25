"use client";

import { useEffect, useRef } from "react";

const steps = [
  {
    step: "01",
    title: "Start with your context",
    body: "Start with the context that makes your company unique: what you are building, your priorities, your team, and the decisions behind the work.",
    tag: "Structured workspace",
  },
  {
    step: "02",
    title: "Connect your sources",
    body: "Bring in meetings, Slack, GitHub, Linear, and agent sessions. Draft turns the activity already happening across your tools into durable company knowledge.",
    tag: "Meetings · Slack · GitHub · Linear",
  },
  {
    step: "03",
    title: "Review what changed",
    body: "New context arrives as proposals, not silent edits. Review what Draft found, accept what matters, and keep your shared brain trustworthy.",
    tag: "Human-reviewed updates",
  },
  {
    step: "04",
    title: "Activate every agent",
    body: "Connect your agents through the desktop app, CLI, or integrations. Each session can start with the current company brain already available.",
    tag: "Claude Code · Codex · Cursor · More",
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
          How teams use it
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
        Search the brain.
        <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
          {" "}Keep every agent current.
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
