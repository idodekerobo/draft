"use client";

const GITHUB_URL = "https://github.com/idodekerobo/draft-cli-plugin";

const TRUST_ITEMS = [
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
      </svg>
    ),
    label: "Open source",
    detail: "MIT License",
    href: GITHUB_URL,
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    ),
    label: "Built for Claude Code",
    detail: "Native plugin",
    href: null,
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    ),
    label: "No sign-up required",
    detail: "Runs locally",
    href: null,
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>
    ),
    label: "claude plugin install draft",
    detail: "One command",
    href: GITHUB_URL,
    mono: true,
  },
];

export default function LogoBar() {
  return (
    <section
      style={{
        borderTop: "1px solid var(--color-border)",
        borderBottom: "1px solid var(--color-border)",
        padding: "2rem 2rem",
        background: "var(--color-surface)",
      }}
    >
      <div
        style={{
          maxWidth: "1000px",
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "clamp(1.5rem, 4vw, 4rem)",
          flexWrap: "wrap",
        }}
      >
        {TRUST_ITEMS.map((item) => {
          const inner = (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.6rem",
              }}
            >
              <span style={{ color: "var(--color-accent)", opacity: 0.8, display: "flex" }}>
                {item.icon}
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                <span
                  style={{
                    fontFamily: item.mono ? "var(--font-mono)" : "var(--font-body)",
                    fontSize: item.mono ? "0.68rem" : "0.78rem",
                    color: "var(--color-primary)",
                    fontWeight: item.mono ? 400 : 500,
                    letterSpacing: item.mono ? "0.02em" : "0",
                    lineHeight: 1,
                  }}
                >
                  {item.label}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    color: "var(--color-faint)",
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    lineHeight: 1,
                  }}
                >
                  {item.detail}
                </span>
              </div>
            </div>
          );

          return item.href ? (
            <a
              key={item.label}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                textDecoration: "none",
                opacity: 0.75,
                transition: "opacity 0.2s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = "1")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = "0.75")}
            >
              {inner}
            </a>
          ) : (
            <div
              key={item.label}
              style={{ opacity: 0.65 }}
            >
              {inner}
            </div>
          );
        })}
      </div>
    </section>
  );
}
