"use client";

import { FormEvent, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { submitWaitlistProfile } from "@/lib/waitlist";
import { AI_TOOL_OPTIONS, ROLE_OPTIONS, TEAM_SIZE_OPTIONS, type ProfileAnswers } from "@/lib/waitlist-questions";

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

const rowStyle = { marginBottom: "0.8rem" } as const;

interface WaitlistProfileStepProps {
  signupToken: string;
  source: string;
  onDone?: (answers: ProfileAnswers) => void;
}

export default function WaitlistProfileStep({ signupToken, source, onDone }: WaitlistProfileStepProps) {
  const ph = usePostHog();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [aiTools, setAiTools] = useState<string[]>([]);
  const [useCase, setUseCase] = useState("");
  const [howHeard, setHowHeard] = useState("");
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const answers: ProfileAnswers = {
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(role ? { role } : {}),
    ...(teamSize ? { team_size: teamSize } : {}),
    ...(aiTools.length > 0 ? { ai_tools: aiTools } : {}),
    ...(useCase.trim() ? { use_case: useCase.trim() } : {}),
    ...(howHeard.trim() ? { how_heard: howHeard.trim() } : {}),
  };
  const hasAnswers = Object.keys(answers).length > 0;

  const toggleTool = (code: string) =>
    setAiTools((current) => (current.includes(code) ? current.filter((item) => item !== code) : [...current, code]));

  const finish = (submitted: ProfileAnswers) => {
    setDone(true);
    onDone?.(submitted);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await submitWaitlistProfile(signupToken, answers);
      ph?.capture(EVENTS.WAITLIST_PROFILE_SUBMITTED, { source });
    } catch {
      // Saving these optional answers never interrupts the signup confirmation.
    } finally {
      setSubmitting(false);
      finish(answers);
    }
  };

  if (done) return null;

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: "1.25rem", textAlign: "left" }}>
      <p style={{ margin: "0 0 0.9rem", color: "var(--color-muted)", fontSize: "0.85rem", lineHeight: 1.5 }}>
        A few optional questions help us prepare for your call.
      </p>
      <div style={rowStyle}>
        <label htmlFor="waitlist-name" style={labelStyle}>Your name</label>
        <input
          id="waitlist-name"
          type="text"
          autoComplete="name"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
          style={fieldStyle}
        />
      </div>
      <div style={rowStyle}>
        <label htmlFor="waitlist-role" style={labelStyle}>Your role</label>
        <select id="waitlist-role" value={role} onChange={(event) => setRole(event.target.value)} style={fieldStyle}>
          <option value="">Select</option>
          {ROLE_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>{option.label}</option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <label htmlFor="waitlist-team-size" style={labelStyle}>How many people on your team use AI at work?</label>
        <select id="waitlist-team-size" value={teamSize} onChange={(event) => setTeamSize(event.target.value)} style={fieldStyle}>
          <option value="">Select</option>
          {TEAM_SIZE_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>{option.label}</option>
          ))}
        </select>
      </div>
      <fieldset style={{ ...rowStyle, border: 0, padding: 0, margin: "0 0 0.8rem" }}>
        <legend style={{ ...labelStyle, padding: 0 }}>Which AI tools does your team use?</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem" }}>
          {AI_TOOL_OPTIONS.map((option) => (
            <label key={option.code} style={{ display: "inline-flex", gap: "0.4rem", alignItems: "center", fontSize: "0.85rem", color: "var(--color-primary)" }}>
              <input type="checkbox" checked={aiTools.includes(option.code)} onChange={() => toggleTool(option.code)} />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div style={rowStyle}>
        <label htmlFor="waitlist-use-case" style={labelStyle}>What are you trying to get done?</label>
        <textarea
          id="waitlist-use-case"
          rows={2}
          maxLength={1000}
          value={useCase}
          onChange={(event) => setUseCase(event.target.value)}
          style={{ ...fieldStyle, resize: "vertical" }}
        />
      </div>
      <div style={{ marginBottom: "0.9rem" }}>
        <label htmlFor="waitlist-how-heard" style={labelStyle}>How did you hear about us?</label>
        <input
          id="waitlist-how-heard"
          type="text"
          maxLength={200}
          value={howHeard}
          onChange={(event) => setHowHeard(event.target.value)}
          style={fieldStyle}
        />
      </div>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button
          type="submit"
          disabled={submitting || !hasAnswers}
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
            opacity: submitting || !hasAnswers ? 0.6 : 1,
          }}
        >
          Send
        </button>
        <button
          type="button"
          onClick={() => finish({})}
          style={{ padding: 0, border: 0, background: "transparent", color: "var(--color-muted)", font: "inherit", fontSize: "0.85rem", cursor: "pointer" }}
        >
          Skip
        </button>
      </div>
    </form>
  );
}
