"use client";

import { useState, useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const DOWNLOAD_URL =
  "https://github.com/idodekerobo/draft/releases/download/v0.1.0/stable-macos-arm64-Draft.dmg";

const CONTEXT_FILES = [
  "workspace/product/index.md",
  "workspace/priorities/index.md",
  "workspace/team/decisions.md",
  "workspace/memory/recent.md",
];

export default function LiveDemo() {
  const ph = usePostHog();
  const [visibleFiles, setVisibleFiles] = useState(0);
  const [showProposal, setShowProposal] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [typedText, setTypedText] = useState("");

  const MESSAGE =
    "3 new proposals from this week's Granola notes. The team shifted the roadmap focus to API-first after Monday's sync — I've staged that decision for your review before it goes out to teammates.";

  useEffect(() => {
    const fileTimers = CONTEXT_FILES.map((_, i) =>
      setTimeout(() => setVisibleFiles(i + 1), 400 + i * 260)
    );
    const proposalTimer = setTimeout(() => setShowProposal(true), 1700);
    const msgTimer = setTimeout(() => setShowMessage(true), 2100);
    return () => {
      fileTimers.forEach(clearTimeout);
      clearTimeout(proposalTimer);
      clearTimeout(msgTimer);
    };
  }, []);

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
        height: "580px",
        boxShadow: "0 1px 2px rgba(28,22,16,0.04), 0 4px 16px rgba(28,22,16,0.06)",
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
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
            Draft · Context Layer
          </span>
        </div>
        {/* Profile pill */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.2rem 0.6rem",
            background: "rgba(200,148,59,0.08)",
            border: "1px solid rgba(200,148,59,0.2)",
            borderRadius: "100px",
          }}
        >
          <span
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: "var(--color-accent)",
              display: "inline-block",
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.58rem",
              color: "var(--color-accent)",
              letterSpacing: "0.06em",
            }}
          >
            acme · default
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
        {/* Session init */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              color: "var(--color-faint)",
              letterSpacing: "0.06em",
            }}
          >
            &gt; session started · loading workspace context
          </span>
        </div>

        {/* Context files loading */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
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

        {/* Proposal badge */}
        {showProposal && (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.25rem 0.65rem",
              background: "rgba(200,148,59,0.07)",
              border: "1px solid rgba(200,148,59,0.25)",
              borderRadius: "6px",
              alignSelf: "flex-start",
              animation: "fadeSlideUp 0.3s ease forwards",
            }}
          >
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v5l3 3" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="8" cy="8" r="6.5" stroke="var(--color-accent)" strokeWidth="1.2"/>
            </svg>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6rem",
                color: "var(--color-accent)",
                letterSpacing: "0.06em",
              }}
            >
              3 proposals pending review
            </span>
          </div>
        )}

        {/* Draft message bubble */}
        {showMessage && (
          <div
            style={{
              marginTop: "0.25rem",
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
                · Context Layer
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
            {["Review proposals →", "Show what changed", "Publish to team →"].map((label) => (
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
          href={DOWNLOAD_URL}
          onClick={() =>
            ph?.capture(EVENTS.CTA_CLICKED, {
              cta_location: "hero_panel",
              cta_text: "Download for macOS",
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
          <svg width="13" height="13" viewBox="0 0 814 1000" fill="currentColor" aria-hidden="true">
            <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-155.5-127.4C46.7 790.7 0 663 0 541.8c0-207.5 135.4-317.1 269-317.1 71 0 130.5 46.4 175 46.4 42.5 0 109.2-49.9 190.5-49.9zm-174.9-41.6c-31.1-36.9-53.3-88.1-53.3-139.3 0-7.1.6-14.3 1.9-20.1 50.6 1.9 110.4 33.7 147.1 75.8 28.5 32.4 55.1 83.6 55.1 135.5 0 7.8-1.3 15.5-1.9 18.1-3.2.6-8.4 1.3-13.6 1.3-45.4 0-102.5-30.4-135.3-71.3z"/>
          </svg>
          Download for macOS
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
          Free · Open source · Apple Silicon · v0.1.0
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
