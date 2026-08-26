/** @deprecated Legacy landing hero. The active homepage uses LandingPage.tsx. */
"use client";

import { useEffect, useRef } from "react";
import { openWaitlistModal } from "@/components/WaitlistModal";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "#";

export default function Hero() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty("--glow-x", `${x}%`);
      el.style.setProperty("--glow-y", `${y}%`);
    };

    el.addEventListener("mousemove", handleMove);
    return () => el.removeEventListener("mousemove", handleMove);
  }, []);

  return (
    <section
      ref={containerRef}
      style={{
        position: "relative",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        paddingTop: "80px",
      }}
      className="blueprint-grid"
    >
      {/* Radial glow that follows mouse */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(800px circle at var(--glow-x, 50%) var(--glow-y, 40%), rgba(200,148,59,0.06), transparent 60%)",
          pointerEvents: "none",
          zIndex: 0,
          "--glow-x": "50%",
          "--glow-y": "40%",
        } as React.CSSProperties}
      />

      {/* Center radial fade for depth */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 80% 60% at 50% 50%, transparent 40%, var(--color-bg) 100%)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      {/* Corner accent marks — like blueprint registration marks */}
      {[
        { top: "80px", left: "40px" },
        { top: "80px", right: "40px" },
        { bottom: "40px", left: "40px" },
        { bottom: "40px", right: "40px" },
      ].map((pos, i) => (
        <svg
          key={i}
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          style={{
            position: "absolute",
            ...pos,
            opacity: 0.2,
            zIndex: 2,
          }}
        >
          <path
            d={i === 0 ? "M0 10 L0 0 L10 0" :
               i === 1 ? "M20 10 L20 0 L10 0" :
               i === 2 ? "M0 10 L0 20 L10 20" :
               "M20 10 L20 20 L10 20"}
            stroke="var(--color-accent)"
            strokeWidth="1.5"
          />
        </svg>
      ))}

      {/* Content */}
      <div
        style={{
          position: "relative",
          zIndex: 3,
          maxWidth: "900px",
          margin: "0 auto",
          padding: "0 2rem",
          textAlign: "center",
        }}
      >
        {/* Eyebrow label */}
        <div
          className="animate-fade-in delay-100"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.35rem 0.875rem",
            border: "1px solid var(--color-border-md)",
            borderRadius: "100px",
            marginBottom: "2.5rem",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "var(--color-accent)",
              display: "inline-block",
              animation: "pulse 2s ease-in-out infinite",
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--color-muted)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Founders and AI-native product teams
          </span>
        </div>

        {/* Main headline */}
        <h1
          className="animate-fade-up delay-200"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(3rem, 9vw, 7.5rem)",
            fontWeight: 500,
            lineHeight: 1.0,
            letterSpacing: "-0.03em",
            color: "var(--color-primary)",
            marginBottom: "1.5rem",
          }}
        >
          A company brain for founders
          <br />
          <span
            style={{
              color: "var(--color-accent)",
              fontStyle: "italic",
            }}
          >
            and AI-native teams.
          </span>
        </h1>

        {/* Subheading */}
        <p
          className="animate-fade-up delay-300"
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "clamp(1rem, 2.5vw, 1.2rem)",
            color: "var(--color-muted)",
            lineHeight: 1.7,
            maxWidth: "600px",
            margin: "0 auto 3rem",
          }}
        >
          Draft turns your company&apos;s decisions, priorities, and activity into
          shared context every connected agent can use. Capture what changes,
          review what matters, and keep every session grounded in the way your team works.
        </p>

        {/* CTAs */}
        <div
          className="animate-fade-up delay-400"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => openWaitlistModal("legacy_hero")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.875rem 2rem",
              background: "var(--color-accent)",
              color: "#0B0B0B",
              fontFamily: "var(--font-body)",
              fontSize: "0.95rem",
              fontWeight: 700,
              border: 0,
              borderRadius: "8px",
              transition: "opacity 0.2s, transform 0.2s, box-shadow 0.2s",
              boxShadow: "0 0 0 0 rgba(200,148,59,0.4)",
              letterSpacing: "0.01em",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.opacity = "0.92";
              el.style.transform = "translateY(-2px)";
              el.style.boxShadow = "0 8px 32px rgba(200,148,59,0.25)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.opacity = "1";
              el.style.transform = "translateY(0)";
              el.style.boxShadow = "0 0 0 0 rgba(200,148,59,0.4)";
            }}
          >
            Join the beta
          </button>

          <a
            href={`${APP_URL}/login`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0.5rem 0.25rem",
              background: "transparent",
              color: "var(--color-muted)",
              fontFamily: "var(--font-body)",
              fontSize: "0.95rem",
              fontWeight: 500,
              textDecoration: "none",
              borderRadius: "6px",
              transition: "color 0.2s",
              letterSpacing: "0.01em",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.color = "var(--color-primary)";
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.color = "var(--color-muted)";
            }}
          >
            Sign in
          </a>
        </div>

        {/* Fine print */}
        <p
          className="animate-fade-in delay-500"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--color-faint)",
            marginTop: "1.25rem",
            letterSpacing: "0.04em",
          }}
        >
          Free to start · No credit card required
        </p>

        {/* Scroll indicator */}
        <div
          className="animate-fade-in delay-700"
          style={{
            marginTop: "5rem",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--color-faint)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            scroll
          </span>
          <div
            style={{
              width: "1px",
              height: "40px",
              background: "linear-gradient(to bottom, var(--color-faint), transparent)",
              animation: "scrollPulse 2s ease-in-out infinite",
            }}
          />
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
        @keyframes scrollPulse {
          0%, 100% { opacity: 0.4; transform: scaleY(1); }
          50% { opacity: 0.8; transform: scaleY(1.1); }
        }
      `}</style>
    </section>
  );
}
