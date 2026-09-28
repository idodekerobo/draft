/** @deprecated Legacy landing footer. The active homepage uses LandingPage.tsx. */
"use client";

import Link from "next/link";

export default function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--color-border)",
        padding: "3rem 2rem",
      }}
    >
      <div
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "2rem",
        }}
      >
        {/* Brand */}
        <div>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.25rem",
              color: "var(--color-primary)",
              letterSpacing: "-0.02em",
              fontWeight: 500,
            }}
          >
            Draft
            <span style={{ color: "var(--color-accent)" }}>.</span>
          </span>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--color-faint)",
              marginTop: "0.5rem",
              letterSpacing: "0.04em",
              maxWidth: "220px",
              lineHeight: 1.6,
            }}
          >
            The company brain for teams using AI agents.
          </p>
        </div>

        {/* Links */}
        <div
          style={{
            display: "flex",
            gap: "3rem",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6rem",
                color: "var(--color-faint)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: "0.25rem",
              }}
            >
              Product
            </span>
            {[
              { label: "Features", href: "#features" },
              { label: "How it works", href: "#how-it-works" },
            ].map((l) => (
              <a
                key={l.label}
                href={l.href}
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "0.8rem",
                  color: "var(--color-muted)",
                  textDecoration: "none",
                  transition: "color 0.2s",
                }}
                onMouseEnter={(e) =>
                  ((e.target as HTMLElement).style.color = "var(--color-primary)")
                }
                onMouseLeave={(e) =>
                  ((e.target as HTMLElement).style.color = "var(--color-muted)")
                }
              >
                {l.label}
              </a>
            ))}
          </div>

        </div>
      </div>

      {/* Bottom bar */}
      <div
        style={{
          maxWidth: "1200px",
          margin: "2rem auto 0",
          paddingTop: "1.5rem",
          borderTop: "1px solid var(--color-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--color-faint)",
            letterSpacing: "0.04em",
          }}
        >
          © {new Date().getFullYear()} Draft. All rights reserved.
        </span>
        <div style={{ display: "flex", gap: "1.5rem" }}>
          {[
            { label: "Privacy Policy", href: "/privacy-policy" },
            { label: "Terms of Use",   href: "/terms"          },
            { label: "Support",        href: "/support"        },
          ].map((l) => (
            <Link
              key={l.label}
              href={l.href}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                color: "var(--color-faint)",
                textDecoration: "none",
                letterSpacing: "0.04em",
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) =>
                ((e.target as HTMLElement).style.color = "var(--color-muted)")
              }
              onMouseLeave={(e) =>
                ((e.target as HTMLElement).style.color = "var(--color-faint)")
              }
            >
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
