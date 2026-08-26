/** @deprecated Legacy landing navigation. The active homepage uses LandingPage.tsx. */
"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { openWaitlistModal } from "@/components/WaitlistModal";

const GITHUB_URL = "https://github.com/idodekerobo/draft";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const ph = usePostHog();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        transition: "background 0.3s ease, border-color 0.3s ease",
        background: scrolled ? "var(--color-nav-bg)" : "transparent",
        borderBottom: `1px solid ${scrolled ? "var(--color-border-md)" : "transparent"}`,
        backdropFilter: scrolled ? "blur(16px)" : "none",
      }}
    >
      <nav
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "0 2rem",
          height: "64px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {/* Logo */}
        <Link href="/" style={{ textDecoration: "none" }}>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.5rem",
              color: "var(--color-primary)",
              letterSpacing: "-0.02em",
              fontWeight: 500,
            }}
          >
            Draft
            <span style={{ color: "var(--color-accent)" }}>.</span>
          </span>
        </Link>

        {/* Desktop Nav */}
        <div
          style={{ display: "flex", alignItems: "center", gap: "2.5rem" }}
          className="hidden-mobile"
        >
          {[
            { label: "Features", href: "#features" },
            { label: "How it works", href: "#how-it-works" },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              {...("external" in link && link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              onClick={() => ph?.capture(EVENTS.NAV_LINK_CLICKED, { source: "nav", label: link.label })}
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "0.875rem",
                color: "var(--color-muted)",
                textDecoration: "none",
                transition: "color 0.2s",
                letterSpacing: "0.01em",
              }}
              onMouseEnter={(e) =>
                ((e.target as HTMLElement).style.color = "var(--color-primary)")
              }
              onMouseLeave={(e) =>
                ((e.target as HTMLElement).style.color = "var(--color-muted)")
              }
            >
              {link.label}
            </a>
          ))}

          {/* GitHub icon link */}
          <a
            href={`${APP_URL}/login`}
            style={{ color: "var(--color-muted)", textDecoration: "none", fontWeight: 500 }}
          >
            Sign in
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="View on GitHub — Open Source"
            onClick={() => ph?.capture(EVENTS.GITHUB_CLICKED, { source: "nav" })}
            style={{
              display: "flex",
              alignItems: "center",
              color: "var(--color-muted)",
              transition: "color 0.2s",
              opacity: 0.7,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--color-primary)";
              (e.currentTarget as HTMLElement).style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "var(--color-muted)";
              (e.currentTarget as HTMLElement).style.opacity = "0.7";
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
          </a>

          {/* Beta CTA */}
          <button
            type="button"
            onClick={() => {
              ph?.capture(EVENTS.CTA_CLICKED, { source: "nav", cta_text: "Join the beta" });
              openWaitlistModal("nav");
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0.5rem 1.25rem",
              background: "var(--color-accent)",
              color: "#0B0B0B",
              fontFamily: "var(--font-body)",
              fontSize: "0.875rem",
              fontWeight: 600,
              border: 0,
              borderRadius: "6px",
              transition: "opacity 0.2s, transform 0.15s",
              letterSpacing: "0.01em",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "0.9";
              (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "1";
              (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
            }}
          >
            Join the beta
          </button>
        </div>

        {/* Mobile inline GitHub link */}
        <div
          className="show-mobile"
          style={{
            display: "none",
            alignItems: "center",
            gap: "0.25rem",
          }}
        >
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => ph?.capture(EVENTS.GITHUB_CLICKED, { source: "nav_mobile_inline" })}
            style={{
              display: "flex",
              alignItems: "center",
              color: "var(--color-muted)",
              opacity: 0.7,
              padding: "12px 16px",
            }}
            aria-label="View on GitHub"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
          </a>
        </div>

        {/* Mobile menu button */}
        <button
          onClick={() => {
            const next = !menuOpen;
            setMenuOpen(next);
            ph?.capture(EVENTS.NAV_MENU_TOGGLED, { action: next ? "open" : "close" });
          }}
          style={{
            display: "none",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "8px",
            color: "var(--color-primary)",
          }}
          className="show-mobile mobile-hamburger"
          aria-label="Toggle menu"
        >
          <div
            style={{
              width: "22px",
              height: "2px",
              background: "currentColor",
              marginBottom: "5px",
              transition: "transform 0.2s",
              transform: menuOpen ? "rotate(45deg) translateY(7px)" : "none",
            }}
          />
          <div
            style={{
              width: "22px",
              height: "2px",
              background: "currentColor",
              opacity: menuOpen ? 0 : 1,
              transition: "opacity 0.2s",
            }}
          />
          <div
            style={{
              width: "22px",
              height: "2px",
              background: "currentColor",
              marginTop: "5px",
              transition: "transform 0.2s",
              transform: menuOpen ? "rotate(-45deg) translateY(-7px)" : "none",
            }}
          />
        </button>
      </nav>

      {/* Mobile Menu */}
      {menuOpen && (
        <div
          style={{
            background: "var(--color-nav-bg-mobile)",
            borderBottom: "1px solid var(--color-border)",
            padding: "1.5rem 2rem",
            display: "flex",
            flexDirection: "column",
            gap: "1.25rem",
          }}
        >
          {[
            { label: "Features", href: "#features" },
            { label: "How it works", href: "#how-it-works" },
          ].map(({ label, href }) => (
            <a
              key={label}
              href={href}
              onClick={() => {
                setMenuOpen(false);
                ph?.capture(EVENTS.NAV_LINK_CLICKED, { source: "nav_mobile", label });
              }}
              style={{ color: "var(--color-muted)", textDecoration: "none", fontSize: "1rem" }}
            >
              {label}
            </a>
          ))}
          <a
            href={`${APP_URL}/login`}
            style={{
              display: "inline-block",
              padding: "0.75rem 1.5rem",
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              fontWeight: 600,
              textDecoration: "none",
              borderRadius: "6px",
              textAlign: "center",
            }}
          >
            Sign in
          </a>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              ph?.capture(EVENTS.CTA_CLICKED, { source: "nav_mobile", cta_text: "Join the beta" });
              openWaitlistModal("nav_mobile");
            }}
            style={{
              display: "inline-block",
              padding: "0.75rem 1.5rem",
              background: "var(--color-accent)",
              color: "#0B0B0B",
              fontWeight: 600,
              border: 0,
              borderRadius: "6px",
              textAlign: "center",
              cursor: "pointer",
            }}
          >
            Join the beta
          </button>
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          .hidden-mobile { display: none !important; }
          .show-mobile { display: flex !important; }
          .mobile-hamburger { flex-direction: column; }
        }
        @media (min-width: 769px) {
          .show-mobile { display: none !important; }
        }
      `}</style>
    </header>
  );
}
