"use client";

import { useEffect, useRef } from "react";

const steps = [
  {
    step: "01",
    title: "Install the plugin",
    body: "Two commands from your terminal. Works on Claude Code and Codex CLI. Free, open source, no sign-up required.",
    code: [
      "/plugin marketplace add idodekerobo/draft-cli-plugin",
      "/plugin install draft",
    ],
  },
  {
    step: "02",
    title: "Run /setup",
    body: "Draft walks you through a short interview — what you're building, your priorities, your role. Takes 5 minutes. Writes structured context files to your workspace.",
    code: ["/draft:setup"],
  },
  {
    step: "03",
    title: "Build with context",
    body: "Every session now opens with your full PM brain loaded. Ask Draft anything — it already knows your product, your roadmap, and what you decided last week.",
    code: null,
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
          maxWidth: "480px",
        }}
      >
        Install once.
        <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>
          {" "}Always loaded.
        </span>
      </h2>

      {/* Steps — horizontal timeline */}
      <div
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "0",
        }}
      >
        {/* Connecting line */}
        <div
          style={{
            position: "absolute",
            top: "20px",
            left: "10%",
            right: "10%",
            height: "1px",
            background:
              "linear-gradient(90deg, transparent, var(--color-border) 20%, var(--color-border) 80%, transparent)",
            pointerEvents: "none",
          }}
        />

        {steps.map((s, i) => (
          <div
            key={s.step}
            className={`reveal reveal-delay-${i + 1}`}
            style={{
              padding: "0 2rem 0 0",
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
                marginBottom: "2rem",
                position: "relative",
                zIndex: 1,
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
                fontSize: "1.2rem",
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
                marginBottom: s.code ? "0.875rem" : 0,
              }}
            >
              {s.body}
            </p>

            {s.code && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {s.code.map((cmd) => (
                  <div
                    key={cmd}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      padding: "0.3rem 0.7rem",
                      background: "rgba(200,148,59,0.07)",
                      border: "1px solid rgba(200,148,59,0.2)",
                      borderRadius: "6px",
                    }}
                  >
                    <span style={{ color: "var(--color-accent)", opacity: 0.6, fontSize: "0.6rem" }}>$</span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.7rem",
                        color: "var(--color-accent)",
                        letterSpacing: "0.02em",
                      }}
                    >
                      {cmd}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
