import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Draft — Context layer for your team's AI sessions";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage() {
  // Load Fraunces (display font) from Google Fonts
  const frauncesBold = await fetch(
    "https://fonts.gstatic.com/s/fraunces/v31/6NUh8FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Bg.woff2"
  ).then((res) => res.arrayBuffer()).catch(() => null);

  const fonts = frauncesBold
    ? [{ name: "Fraunces", data: frauncesBold, style: "italic" as const, weight: 500 as const }]
    : [];

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          background: "#0B0B0B",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          position: "relative",
          overflow: "hidden",
          fontFamily: fonts.length ? "Fraunces" : "Georgia, serif",
        }}
      >
        {/* Blueprint grid — horizontal lines */}
        {Array.from({ length: 14 }).map((_, i) => (
          <div
            key={`h${i}`}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: `${(i + 1) * 45}px`,
              height: "1px",
              background: "rgba(237,229,208,0.04)",
            }}
          />
        ))}
        {/* Blueprint grid — vertical lines */}
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={`v${i}`}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${(i + 1) * 60}px`,
              width: "1px",
              background: "rgba(237,229,208,0.04)",
            }}
          />
        ))}

        {/* Radial amber glow — bottom left */}
        <div
          style={{
            position: "absolute",
            bottom: "-100px",
            left: "-80px",
            width: "600px",
            height: "500px",
            background:
              "radial-gradient(ellipse at center, rgba(200,148,59,0.12) 0%, transparent 70%)",
          }}
        />

        {/* Top: Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span
            style={{
              fontFamily: fonts.length ? "Fraunces" : "Georgia, serif",
              fontStyle: "italic",
              fontSize: "36px",
              fontWeight: 500,
              color: "#EDE5D0",
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            Draft
          </span>
          <span
            style={{
              fontFamily: fonts.length ? "Fraunces" : "Georgia, serif",
              fontStyle: "italic",
              fontSize: "36px",
              fontWeight: 500,
              color: "#C8943B",
              lineHeight: 1,
            }}
          >
            .
          </span>
        </div>

        {/* Center: Main headline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "4px",
            }}
          >
            {/* Accent rule */}
            <div
              style={{
                width: "32px",
                height: "1px",
                background: "#C8943B",
                opacity: 0.7,
              }}
            />
            <span
              style={{
                fontSize: "13px",
                fontFamily: "monospace",
                color: "#C8943B",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                opacity: 0.8,
              }}
            >
              Context layer
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0px" }}>
            <span
              style={{
                fontFamily: fonts.length ? "Fraunces" : "Georgia, serif",
                fontStyle: "italic",
                fontSize: "74px",
                fontWeight: 500,
                color: "#EDE5D0",
                letterSpacing: "-0.03em",
                lineHeight: 1.0,
              }}
            >
              Your team&apos;s agent sessions,
            </span>
            <span
              style={{
                fontFamily: fonts.length ? "Fraunces" : "Georgia, serif",
                fontStyle: "italic",
                fontSize: "74px",
                fontWeight: 500,
                color: "#C8943B",
                letterSpacing: "-0.03em",
                lineHeight: 1.0,
              }}
            >
              always grounded.
            </span>
          </div>
        </div>

        {/* Bottom: Description + platform tags */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          <span
            style={{
              fontSize: "18px",
              fontFamily: "system-ui, sans-serif",
              color: "rgba(237,229,208,0.45)",
              maxWidth: "560px",
              lineHeight: 1.5,
              letterSpacing: "0.01em",
            }}
          >
            Captures context from meetings, Slack, and GitHub — injects it automatically at every session start.
          </span>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-end" }}>
            {["Claude Code", "Codex", "Cursor"].map((tool) => (
              <div
                key={tool}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "5px 12px",
                  background: "rgba(200,148,59,0.08)",
                  border: "1px solid rgba(200,148,59,0.2)",
                  borderRadius: "100px",
                }}
              >
                <div
                  style={{
                    width: "5px",
                    height: "5px",
                    borderRadius: "50%",
                    background: "#C8943B",
                    opacity: 0.7,
                  }}
                />
                <span
                  style={{
                    fontSize: "12px",
                    fontFamily: "monospace",
                    color: "#C8943B",
                    letterSpacing: "0.04em",
                    opacity: 0.85,
                  }}
                >
                  {tool}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts,
    }
  );
}
