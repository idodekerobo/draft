"use client";

import { useEffect, useRef } from "react";

const personas = [
  {
    label: "01 — Co-founders",
    headline: "Own product. Keep pace with your engineer.",
    body: "You're the product brain — strategy, specs, prioritization — while your co-founder ships. The problem is Claude Code starts blank every session. Draft gives it persistent memory so every session starts with your full context loaded. No re-briefing. Just product work.",
    tag: "Co-founder, product mode",
  },
  {
    label: "02 — Heads of Product",
    headline: "Set the source of truth. Once.",
    body: "You're the curator — the one person who owns the product context everyone else operates from. Draft is built for that role. Run /setup once, and your strategy, decisions, and priorities are structured, versioned, and loaded automatically. Your team pulls from what you set. You stop re-explaining it.",
    tag: "Curator mode",
  },
  {
    label: "03 — Solo founders",
    headline: "You're doing all the jobs. Draft covers the PM one.",
    body: "Product, engineering, GTM — it's all you. Context loss hits hardest when you're switching between all three in the same day. Draft keeps your product brain intact across every Claude session so when you're back in PM mode, you're not starting from scratch.",
    tag: "Full-stack founder",
  },
];

export default function ForWho() {
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
      ref={sectionRef}
      style={{
        padding: "7rem 2rem",
        maxWidth: "1200px",
        margin: "0 auto",
      }}
    >
      {/* Section label */}
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
          Who it&#39;s for
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
          marginBottom: "4rem",
          maxWidth: "500px",
        }}
      >
        Built for the product mind behind the code.
      </h2>

      {/* Cards grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "1.5px",
          background: "var(--color-border)",
          border: "1px solid var(--color-border)",
          borderRadius: "12px",
          overflow: "hidden",
        }}
      >
        {personas.map((p, i) => (
          <div
            key={p.label}
            className={`reveal reveal-delay-${i + 1}`}
            style={{
              background: "var(--color-surface)",
              padding: "2.5rem",
              transition: "background 0.2s",
              cursor: "default",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface-2)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface)";
            }}
          >
            {/* Label */}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                color: "var(--color-accent)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                display: "block",
                marginBottom: "1.5rem",
              }}
            >
              {p.label}
            </span>

            {/* Headline */}
            <h3
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1.5rem",
                fontWeight: 500,
                letterSpacing: "-0.02em",
                lineHeight: 1.2,
                color: "var(--color-primary)",
                marginBottom: "1rem",
              }}
            >
              {p.headline}
            </h3>

            {/* Body */}
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.9rem",
                color: "var(--color-muted)",
                lineHeight: 1.7,
                marginBottom: "2rem",
              }}
            >
              {p.body}
            </p>

            {/* Tag */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                padding: "0.3rem 0.75rem",
                background: "rgba(200, 148, 59, 0.08)",
                border: "1px solid rgba(200, 148, 59, 0.2)",
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
                }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.65rem",
                  color: "var(--color-accent)",
                  letterSpacing: "0.04em",
                }}
              >
                {p.tag}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
