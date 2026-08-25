"use client";

import { useEffect, useRef } from "react";

const personas = [
  {
    label: "01 — Founders shipping with agents",
    headline: "Keep the details close to the work.",
    body: "You move between customers, product, and code all day. Draft helps your agents find the decisions, feedback, and customer details you do not want to re-explain every time.",
    tag: "Founder mode",
  },
  {
    label: "02 — AI-native product teams",
    headline: "Make team knowledge available wherever agents work.",
    body: "When multiple agents work across product and engineering, Draft helps the team find the latest feedback, decisions, and rationale without maintaining another manual knowledge base.",
    tag: "Team mode",
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
        Let everyone find what they need without waiting on you.
      </h2>

      <p
        className="reveal reveal-delay-2"
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "1rem",
          color: "var(--color-muted)",
          lineHeight: 1.7,
          maxWidth: "560px",
          margin: "-2.5rem 0 4rem",
        }}
      >
        Draft synthesizes company context from the work already happening, so
        founders, teammates, and agents can find the details behind the work
        themselves.
      </p>

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
