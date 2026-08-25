"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const GITHUB_URL = "https://github.com/idodekerobo/draft";
const DOCS_URL = "https://github.com/idodekerobo/draft/tree/main/docs";
const DOWNLOAD_URL =
  "https://github.com/idodekerobo/draft/releases/latest/download/stable-macos-arm64-Draft.dmg";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.draftai.us";

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const ph = usePostHog();
  const downloadCta = "Download desktop app";

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
            { label: "Docs", href: DOCS_URL, external: true },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              {...("external" in link && link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              onClick={() =>
                link.label === "Docs"
                  ? ph?.capture(EVENTS.DOCS_CLICKED, { source: "nav" })
                  : ph?.capture(EVENTS.NAV_LINK_CLICKED, { source: "nav", label: link.label })
              }
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
          <a href={`${APP_URL}/signup`} style={{ color: "var(--color-accent)", textDecoration: "none", fontWeight: 600 }}>Get Started</a>
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

          {/* Download CTA */}
          <a
            href={DOWNLOAD_URL}
            onClick={() => ph?.capture(EVENTS.DOWNLOAD_CLICKED, { source: "nav" })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.5rem 1.25rem",
              background: "var(--color-accent)",
              color: "#0B0B0B",
              fontFamily: "var(--font-body)",
              fontSize: "0.875rem",
              fontWeight: 600,
              textDecoration: "none",
              borderRadius: "6px",
              transition: "opacity 0.2s, transform 0.15s",
              letterSpacing: "0.01em",
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
            {/* Apple icon */}
            <svg width="13" height="13" viewBox="0 0 814 1000" fill="currentColor" aria-hidden="true">
              <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-37.5-155.5-127.4C46.7 790.7 0 663 0 541.8c0-207.5 135.4-317.1 269-317.1 71 0 130.5 46.4 175 46.4 42.5 0 109.2-49.9 190.5-49.9zm-174.9-41.6c-31.1-36.9-53.3-88.1-53.3-139.3 0-7.1.6-14.3 1.9-20.1 50.6 1.9 110.4 33.7 147.1 75.8 28.5 32.4 55.1 83.6 55.1 135.5 0 7.8-1.3 15.5-1.9 18.1-3.2.6-8.4 1.3-13.6 1.3-45.4 0-102.5-30.4-135.3-71.3z"/>
            </svg>
            {downloadCta}
          </a>
        </div>

        {/* Mobile inline links (Docs + GitHub) */}
        <div
          className="show-mobile"
          style={{
            display: "none",
            alignItems: "center",
            gap: "0.25rem",
          }}
        >
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => ph?.capture(EVENTS.DOCS_CLICKED, { source: "nav_mobile_inline" })}
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "0.875rem",
              color: "var(--color-muted)",
              textDecoration: "none",
              letterSpacing: "0.01em",
              padding: "12px 16px",
            }}
          >
            Docs
          </a>
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
            href={`${APP_URL}/signup`}
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
            Get Started
          </a>
          <a
            href={DOWNLOAD_URL}
            onClick={() => ph?.capture(EVENTS.DOWNLOAD_CLICKED, { source: "nav_mobile" })}
            style={{
              display: "inline-block",
              padding: "0.75rem 1.5rem",
              background: "var(--color-accent)",
              color: "#0B0B0B",
              fontWeight: 600,
              textDecoration: "none",
              borderRadius: "6px",
              textAlign: "center",
            }}
          >
            {downloadCta}
          </a>
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
