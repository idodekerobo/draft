"use client";

import { useEffect, useRef } from "react";
import DemoHeroLeft from "./DemoHeroLeft";
import LiveDemo from "./LiveDemo";

export default function DemoHero() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--glow-x", `${((e.clientX - rect.left) / rect.width) * 100}%`);
      el.style.setProperty("--glow-y", `${((e.clientY - rect.top) / rect.height) * 100}%`);
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <section
      ref={containerRef}
      className="blueprint-grid"
      style={{
        position: "relative",
        minHeight: "100vh",
        paddingTop: "64px",
        display: "flex",
        alignItems: "center",
        // Prevent horizontal scroll at all viewport sizes
        overflow: "hidden",
        "--glow-x": "50%",
        "--glow-y": "40%",
      } as React.CSSProperties}
    >
      {/* Mouse-tracking glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(800px circle at var(--glow-x) var(--glow-y), rgba(168,110,32,0.07), transparent 60%)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* Edge vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 110% 90% at 50% 50%, transparent 35%, var(--color-bg) 100%)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      {/* Split content — CSS grid avoids gap-overflow issues with flex percentages */}
      <div
        className="demo-hero-split"
        style={{
          position: "relative",
          zIndex: 2,
          width: "100%",
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "5rem 2rem",
          display: "grid",
          gridTemplateColumns: "43fr 57fr",
          gap: "3.5rem",
          alignItems: "center",
          // Ensure the grid itself never overflows the section
          minWidth: 0,
        }}
      >
        <DemoHeroLeft />
        <LiveDemo />
      </div>

      <style>{`
        @media (max-width: 900px) {
          .demo-hero-split {
            grid-template-columns: 1fr !important;
            padding: 2.5rem 1.25rem 3.5rem !important;
            gap: 2.5rem !important;
          }
        }
      `}</style>
    </section>
  );
}
