"use client";

import { FormEvent, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { submitWaitlistProfile } from "@/lib/waitlist";

const fieldStyle = {
  width: "100%",
  padding: "0.7rem 0.85rem",
  border: "1px solid var(--color-border-md)",
  borderRadius: "6px",
  background: "var(--color-surface)",
  color: "var(--color-primary)",
  font: "inherit",
  fontSize: "0.9rem",
  boxSizing: "border-box",
} as const;

const labelStyle = {
  display: "block",
  margin: "0 0 0.35rem",
  color: "var(--color-muted)",
  fontSize: "0.8rem",
  lineHeight: 1.5,
} as const;

export default function WaitlistProfileStep({ email, source }: { email: string; source: string }) {
  const ph = usePostHog();
  const [howHeard, setHowHeard] = useState("");
  const [useCase, setUseCase] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await submitWaitlistProfile(email, { how_heard: howHeard, use_case: useCase, team_size: teamSize });
      ph?.capture(EVENTS.WAITLIST_PROFILE_SUBMITTED, { source });
    } catch {
      // The signup is already saved; losing these answers is acceptable.
    }
    setDone(true);
  };

  if (done) {
    return (
      <p role="status" style={{ margin: "1rem 0 0", color: "var(--color-muted)", fontSize: "0.9rem" }}>
        Thanks, that helps.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "1.25rem", textAlign: "left" }}>
      <p style={{ margin: "0 0 0.9rem", color: "var(--color-muted)", fontSize: "0.85rem", lineHeight: 1.5 }}>
        A few optional questions to learn more about you.
      </p>
      <label htmlFor="waitlist-use-case" style={labelStyle}>What do you use AI for in your business?</label>
      <textarea
        id="waitlist-use-case"
        rows={2}
        maxLength={1000}
        value={useCase}
        onChange={(event) => setUseCase(event.target.value)}
        style={{ ...fieldStyle, marginBottom: "0.8rem", resize: "vertical" }}
      />
      <label htmlFor="waitlist-team-size" style={labelStyle}>How large is your team?</label>
      <input
        id="waitlist-team-size"
        type="text"
        maxLength={200}
        value={teamSize}
        onChange={(event) => setTeamSize(event.target.value)}
        style={{ ...fieldStyle, marginBottom: "0.8rem" }}
      />
      <label htmlFor="waitlist-how-heard" style={labelStyle}>How did you hear about us?</label>
      <input
        id="waitlist-how-heard"
        type="text"
        maxLength={200}
        value={howHeard}
        onChange={(event) => setHowHeard(event.target.value)}
        style={{ ...fieldStyle, marginBottom: "0.9rem" }}
      />
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button
          type="submit"
          disabled={submitting || (!howHeard.trim() && !useCase.trim() && !teamSize.trim())}
          style={{
            padding: "0.65rem 1.1rem",
            border: 0,
            borderRadius: "6px",
            background: "var(--color-accent)",
            color: "var(--color-on-accent)",
            font: "inherit",
            fontSize: "0.85rem",
            fontWeight: 700,
            cursor: submitting ? "wait" : "pointer",
            opacity: submitting || (!howHeard.trim() && !useCase.trim() && !teamSize.trim()) ? 0.6 : 1,
          }}
        >
          Send
        </button>
        <button
          type="button"
          onClick={() => setDone(true)}
          style={{ padding: 0, border: 0, background: "transparent", color: "var(--color-muted)", font: "inherit", fontSize: "0.85rem", cursor: "pointer" }}
        >
          Skip
        </button>
      </div>
    </form>
  );
}
