"use client";

import { useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { openWaitlistModal } from "@/components/WaitlistModal";

const GITHUB_URL = "https://github.com/idodekerobo/draft";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";

export default function CTASection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const ph = usePostHog();

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.querySelectorAll(".reveal").forEach((el) => el.classList.add("in-view"));
        });
      },
      { threshold: 0.2 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} style={{ padding: "7rem 2rem", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(200,148,59,0.05), transparent 70%)", pointerEvents: "none" }} />
      <div style={{ maxWidth: "720px", margin: "0 auto", textAlign: "center", position: "relative", zIndex: 1 }}>
        <div className="reveal" style={{ marginBottom: "2rem", display: "flex", justifyContent: "center" }}>
          <div style={{ width: "48px", height: "48px", border: "1px solid var(--color-border-md)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: "1.25rem", color: "var(--color-accent)", fontStyle: "italic" }}>D</span>
          </div>
        </div>

        <h2 className="reveal reveal-delay-1" style={{ fontFamily: "var(--font-display)", fontSize: "clamp(2.5rem, 7vw, 5.5rem)", fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1, color: "var(--color-primary)", marginBottom: "1.5rem" }}>
          Your company,
          <br />
          <span style={{ color: "var(--color-accent)", fontStyle: "italic" }}>available to every agent.</span>
        </h2>

        <p className="reveal reveal-delay-2" style={{ fontFamily: "var(--font-body)", fontSize: "1.05rem", color: "var(--color-muted)", lineHeight: 1.7, maxWidth: "480px", margin: "0 auto 3rem" }}>
          Draft keeps your team&apos;s decisions, priorities, and working context current — then makes them available wherever your agents work.
        </p>

        <div className="reveal reveal-delay-3" style={{ textAlign: "center" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "1rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                ph?.capture(EVENTS.CTA_CLICKED, { source: "cta_section", cta_text: "Join the beta" });
                openWaitlistModal("cta_section");
              }}
              style={{ display: "inline-flex", alignItems: "center", padding: "1rem 2rem", background: "var(--color-accent)", color: "#0B0B0B", fontFamily: "var(--font-body)", fontSize: "1rem", fontWeight: 700, border: 0, borderRadius: "8px", transition: "opacity 0.2s, transform 0.2s, box-shadow 0.2s", letterSpacing: "0.01em", cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.9"; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 12px 40px rgba(200,148,59,0.3)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}
            >
              Join the beta
            </button>
            <a
              href={`${APP_URL}/login`}
              style={{ color: "var(--color-muted)", fontFamily: "var(--font-body)", fontSize: "1rem", fontWeight: 500, textDecoration: "none", transition: "color 0.2s", letterSpacing: "0.01em" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-primary)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-muted)"; }}
            >
              Sign in
            </a>
          </div>

          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => ph?.capture(EVENTS.GITHUB_CLICKED, { source: "cta_section" })}
            style={{ display: "inline-block", marginTop: "1.5rem", color: "var(--color-muted)", fontFamily: "var(--font-body)", fontSize: "0.875rem", textDecoration: "none", transition: "color 0.2s" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-muted)"; }}
          >
            GitHub · View the source code →
          </a>
        </div>

        <p className="reveal reveal-delay-4" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--color-faint)", marginTop: "1.5rem", letterSpacing: "0.04em" }}>
          Hosted or self-hosted · Open source · Human-reviewed updates
        </p>
      </div>
    </section>
  );
}
