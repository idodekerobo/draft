"use client";

import { useState, useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const GITHUB_URL = "https://github.com/idodekerobo/draft-cli-plugin";

const CONTEXT_FILES = [
  "product/index.md",
  "priorities/index.md",
  "company/index.md",
  "memory/memory.md",
];

export default function LiveDemo() {
  const ph = usePostHog();
  const [visibleFiles, setVisibleFiles] = useState(0);
  const [showMessage, setShowMessage] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [typedText, setTypedText] = useState("");

  const MESSAGE =
    "Your homepage still leads with the team collaboration angle you deprioritized last quarter. Solo founders are landing and bouncing because the copy doesn't match what you're actually selling.";

  // Staggered entrance: context files load, then message types in
  useEffect(() => {
    const fileTimers = CONTEXT_FILES.map((_, i) =>
      setTimeout(() => setVisibleFiles(i + 1), 400 + i * 280)
    );
    const msgTimer = setTimeout(() => setShowMessage(true), 1800);
    return () => {
      fileTimers.forEach(clearTimeout);
      clearTimeout(msgTimer);
    };
  }, []);

  // Typewriter for the message
  useEffect(() => {
    if (!showMessage) return;
    let i = 0;
    const tick = setInterval(() => {
      i++;
      setTypedText(MESSAGE.slice(0, i));
      if (i >= MESSAGE.length) {
        clearInterval(tick);
        setTimeout(() => setShowActions(true), 300);
      }
    }, 18);
    return () => clearInterval(tick);
  }, [showMessage]);

  return (
    <div
      style={{
        position: "relative",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border-md)",
        borderRadius: "12px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        height: "480px",
        boxShadow:
          "0 1px 2px rgba(28,22,16,0.04), 0 4px 16px rgba(28,22,16,0.06)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0.75rem 1rem",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface-2)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#4ade80",
              display: "inline-block",
              animation: "livePulse 2s ease-in-out infinite",
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.68rem",
              color: "var(--color-muted)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Draft · PM Agent
          </span>
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "1.25rem 1.25rem 1rem",
          gap: "0.875rem",
          overflowY: "hidden",
        }}
      >
        {/* Session init line */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              color: "var(--color-faint)",
              letterSpacing: "0.06em",
            }}
          >
            &gt; session started · loading context
          </span>
        </div>

        {/* Context files loading */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.3rem",
          }}
        >
          {CONTEXT_FILES.map((file, i) => (
            <div
              key={file}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                opacity: i < visibleFiles ? 1 : 0,
                transform: i < visibleFiles ? "translateX(0)" : "translateX(-6px)",
                transition: "opacity 0.3s ease, transform 0.3s ease",
              }}
            >
              <svg width="8" height="8" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <circle cx="8" cy="8" r="7" stroke="var(--color-accent-2)" strokeWidth="1.5" />
                <path
                  d="M5 8l2 2 4-4"
                  stroke="var(--color-accent-2)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.62rem",
                  color: "var(--color-muted)",
                  letterSpacing: "0.04em",
                }}
              >
                {file}
              </span>
            </div>
          ))}
        </div>

        {/* Draft message bubble */}
        {showMessage && (
          <div
            style={{
              marginTop: "0.5rem",
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-md)",
              borderRadius: "10px",
              padding: "0.875rem 1rem",
              animation: "fadeSlideUp 0.35s ease forwards",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                marginBottom: "0.625rem",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "0.78rem",
                  fontWeight: 500,
                  fontStyle: "italic",
                  color: "var(--color-accent)",
                }}
              >
                Draft
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.58rem",
                  color: "var(--color-faint)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                · PM Brain
              </span>
            </div>
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.8rem",
                color: "var(--color-primary)",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              {typedText}
              {typedText.length < MESSAGE.length && (
                <span
                  style={{
                    display: "inline-block",
                    width: "2px",
                    height: "0.85em",
                    background: "var(--color-accent)",
                    marginLeft: "1px",
                    verticalAlign: "text-bottom",
                    animation: "cursorBlink 0.8s step-end infinite",
                  }}
                />
              )}
            </p>
          </div>
        )}

        {/* Quick-action chips */}
        {showActions && (
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              animation: "fadeSlideUp 0.3s ease forwards",
            }}
          >
            {["Update landing page →", "Show me what's stale"].map((label) => (
              <button
                key={label}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.62rem",
                  color: "var(--color-accent)",
                  background: "rgba(200,148,59,0.08)",
                  border: "1px solid rgba(200,148,59,0.25)",
                  borderRadius: "6px",
                  padding: "0.3rem 0.7rem",
                  cursor: "default",
                  letterSpacing: "0.03em",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(200,148,59,0.15)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(200,148,59,0.08)";
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* CTA footer */}
      <div
        style={{
          padding: "1rem",
          borderTop: "1px solid var(--color-border)",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          flexShrink: 0,
        }}
      >
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() =>
            ph?.capture(EVENTS.CTA_CLICKED, {
              cta_location: "hero_panel",
              cta_text: "Install the plugin",
            })
          }
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            padding: "0.875rem",
            background: "var(--color-accent)",
            color: "#0B0B0B",
            fontFamily: "var(--font-body)",
            fontSize: "0.9rem",
            fontWeight: 700,
            textDecoration: "none",
            borderRadius: "8px",
            transition: "opacity 0.2s, transform 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "0.9";
            e.currentTarget.style.transform = "translateY(-1px)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "1";
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          Install the plugin
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
            fontSize: "0.65rem",
            color: "var(--color-faint)",
            letterSpacing: "0.05em",
            textAlign: "center",
          }}
        >
          Free · Open source · No sign-up required
        </span>
      </div>

      <style>{`
        @keyframes livePulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.75)} }
        @keyframes fadeSlideUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes cursorBlink { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>
    </div>
  );
}
