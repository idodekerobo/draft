"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";

const OPEN_WAITLIST_EVENT = "draft:open-waitlist";

export function openWaitlistModal(source: string) {
  window.dispatchEvent(
    new CustomEvent(OPEN_WAITLIST_EVENT, { detail: { source } }),
  );
}

type SubmitState = "idle" | "submitting" | "success" | "error";

export default function WaitlistModal() {
  const ph = usePostHog();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("unknown");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      setSource(detail?.source ?? "unknown");
      setSubmitState("idle");
      setOpen(true);
      ph?.capture(EVENTS.WAITLIST_OPENED, { source: detail?.source ?? "unknown" });
    };

    window.addEventListener(OPEN_WAITLIST_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_WAITLIST_EVENT, handleOpen);
  }, [ph]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitState("submitting");

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source }),
      });

      if (!response.ok) throw new Error("Waitlist submission failed");

      ph?.capture(EVENTS.WAITLIST_SUBMITTED, { source });
      setSubmitState("success");
    } catch {
      setSubmitState("error");
    }
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.25rem",
        background: "rgba(28, 22, 16, 0.44)",
        backdropFilter: "blur(5px)",
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="waitlist-title"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "500px",
          padding: "2.5rem",
          background: "var(--color-bg)",
          border: "1px solid var(--color-border-md)",
          borderRadius: "16px",
          boxShadow: "0 24px 80px rgba(28,22,16,0.24)",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close waitlist dialog"
          style={{
            position: "absolute",
            top: "1rem",
            right: "1rem",
            width: "2rem",
            height: "2rem",
            border: "1px solid var(--color-border-md)",
            borderRadius: "50%",
            background: "transparent",
            color: "var(--color-muted)",
            fontSize: "1.25rem",
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ×
        </button>

        {submitState === "success" ? (
          <div style={{ textAlign: "center", padding: "1rem 0" }}>
            <div
              aria-hidden="true"
              style={{
                width: "3rem",
                height: "3rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 1.25rem",
                border: "1px solid var(--color-accent)",
                borderRadius: "50%",
                color: "var(--color-accent)",
                fontSize: "1.5rem",
              }}
            >
              ✓
            </div>
            <h2
              id="waitlist-title"
              style={{
                margin: "0 0 0.75rem",
                fontFamily: "var(--font-display)",
                fontSize: "2rem",
                fontWeight: 500,
                lineHeight: 1.1,
              }}
            >
              You&apos;re on the list.
            </h2>
            <p style={{ margin: 0, color: "var(--color-muted)", lineHeight: 1.6 }}>
              We&apos;ll be in touch when a beta spot opens up.
            </p>
          </div>
        ) : (
          <>
            <h2
              id="waitlist-title"
              style={{
                margin: "0 0 0.75rem",
                fontFamily: "var(--font-display)",
                fontSize: "clamp(2rem, 6vw, 2.75rem)",
                fontWeight: 500,
                lineHeight: 1.05,
                letterSpacing: "-0.025em",
              }}
            >
              Join the Draft beta.
            </h2>
            <p style={{ margin: "0 0 1.75rem", color: "var(--color-muted)", lineHeight: 1.6 }}>
              Leave your email and we&apos;ll let you know when a spot opens.
            </p>

            <form onSubmit={handleSubmit}>
              <label htmlFor="waitlist-email" className="sr-only">Email address</label>
              <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
                <input
                  ref={inputRef}
                  id="waitlist-email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={submitState === "submitting"}
                  style={{
                    flex: "1 1 220px",
                    minWidth: 0,
                    padding: "0.9rem 1rem",
                    border: "1px solid var(--color-border-md)",
                    borderRadius: "8px",
                    background: "rgba(255,255,255,0.44)",
                    color: "var(--color-primary)",
                    font: "inherit",
                    outlineColor: "var(--color-accent)",
                  }}
                />
                <button
                  type="submit"
                  disabled={submitState === "submitting"}
                  style={{
                    flex: "0 0 auto",
                    padding: "0.9rem 1.25rem",
                    border: 0,
                    borderRadius: "8px",
                    background: "var(--color-accent)",
                    color: "#0B0B0B",
                    font: "inherit",
                    fontWeight: 700,
                    cursor: submitState === "submitting" ? "wait" : "pointer",
                    opacity: submitState === "submitting" ? 0.7 : 1,
                  }}
                >
                  {submitState === "submitting" ? "Joining…" : "Join the beta"}
                </button>
              </div>
              {submitState === "error" && (
                <p role="alert" style={{ margin: "0.75rem 0 0", color: "#9B3C2E", fontSize: "0.875rem" }}>
                  Something went wrong. Please try again.
                </p>
              )}
              <p style={{ margin: "1rem 0 0", color: "var(--color-faint)", fontSize: "0.75rem" }}>
                No spam. Just beta updates.
              </p>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
