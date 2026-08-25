"use client";

import { useState, useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { openWaitlistModal } from "@/components/WaitlistModal";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";

const SEARCH_STEPS = [
  "meeting notes · launch planning",
  "Slack threads · product feedback",
  "active decisions · roadmap",
];

const BRAIN_ENTRIES = [
  {
    label: "Feedback",
    value: "Every launch plan includes one customer proof point and a named distribution owner.",
  },
  {
    label: "Source",
    value: "Launch planning thread · Marketing · 2 weeks ago",
  },
  {
    label: "Current focus",
    value: "Make the API the primary integration surface.",
  },
];

export default function LiveDemo() {
  const ph = usePostHog();
  const [visibleSearchSteps, setVisibleSearchSteps] = useState(0);
  const [showBrain, setShowBrain] = useState(false);
  const [showProposal, setShowProposal] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [typedText, setTypedText] = useState("");

  const MESSAGE =
    "Marketing feedback found: every launch plan should include one customer proof point and a named distribution owner. Draft added it to the context for review.";

  useEffect(() => {
    const searchTimers = SEARCH_STEPS.map((_, i) =>
      setTimeout(() => setVisibleSearchSteps(i + 1), 400 + i * 260)
    );
    const brainTimer = setTimeout(() => setShowBrain(true), 1550);
    const proposalTimer = setTimeout(() => setShowProposal(true), 3000);
    const msgTimer = setTimeout(() => setShowMessage(true), 3350);
    return () => {
      searchTimers.forEach(clearTimeout);
      clearTimeout(brainTimer);
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
      className="live-demo"
      style={{
        position: "relative",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border-md)",
        borderRadius: "12px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        height: "700px",
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
              fontSize: "0.75rem",
              color: "var(--color-primary)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Draft · Company Brain
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
              fontSize: "0.65rem",
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
              fontSize: "0.75rem",
              color: "var(--color-muted)",
              letterSpacing: "0.06em",
            }}
          >
            &gt; agent request · create launch plan for API integrations
          </span>
        </div>

        {/* Search progress */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {SEARCH_STEPS.map((step, i) => (
            <div
              key={step}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                opacity: i < visibleSearchSteps ? 1 : 0,
                transform: i < visibleSearchSteps ? "translateX(0)" : "translateX(-6px)",
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
                  fontSize: "0.75rem",
                  color: "var(--color-primary)",
                  letterSpacing: "0.04em",
                }}
              >
                {step}
              </span>
            </div>
          ))}
        </div>

        {/* Company brain snapshot */}
        {showBrain && (
          <div
            style={{
              background: "var(--color-bg)",
              border: "1px solid var(--color-border-md)",
              borderRadius: "8px",
              padding: "0.75rem 0.875rem",
              animation: "fadeSlideUp 0.35s ease forwards",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.5rem",
                marginBottom: "0.625rem",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.68rem",
                  color: "var(--color-accent)",
                  letterSpacing: "0.07em",
                  textTransform: "uppercase",
                }}
              >
                Company brain loaded
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.62rem",
                  color: "var(--color-faint)",
                }}
              >
                acme · current
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
              {BRAIN_ENTRIES.map((entry) => (
                <div
                  key={entry.label}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "5.25rem 1fr",
                    gap: "0.5rem",
                    alignItems: "baseline",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.62rem",
                      color: "var(--color-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {entry.label}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: "0.8rem",
                      color: "var(--color-primary)",
                      lineHeight: 1.4,
                    }}
                  >
                    {entry.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

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
                fontSize: "0.68rem",
                color: "var(--color-accent)",
                letterSpacing: "0.06em",
              }}
            >
              1 relevant memory found
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
                  fontSize: "0.65rem",
                  color: "var(--color-faint)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                · Company Brain
              </span>
            </div>
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.9rem",
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
            {["Use in launch plan →", "Show source", "Add to company brain →"].map((label) => (
              <button
                key={label}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.7rem",
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
        <button
          type="button"
          onClick={() =>
            (() => {
              ph?.capture(EVENTS.CTA_CLICKED, {
                cta_location: "hero_panel",
                cta_text: "Join the beta",
              });
              openWaitlistModal("hero_panel");
            })()
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
            border: 0,
            cursor: "pointer",
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
          Join the beta
        </button>
        <a
          href={`${APP_URL}/login`}
          style={{
            color: "var(--color-muted)",
            fontFamily: "var(--font-body)",
            fontSize: "0.8rem",
            textAlign: "center",
            textDecoration: "none",
          }}
        >
          Already have access? Sign in
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
          Hosted or self-hosted · Open source
        </span>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .live-demo { height: 840px !important; }
        }
        @keyframes livePulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.75)} }
        @keyframes fadeSlideUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes cursorBlink { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>
    </div>
  );
}
