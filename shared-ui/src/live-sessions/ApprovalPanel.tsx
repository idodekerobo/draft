"use client";

import { useState } from "react";
import type { OpenApproval } from "./stream-items";
import { closedMessage } from "./approval-result";
import type { ApprovalResponse, ApprovalResult } from "./types";

const PREVIEW_LINES = 3;

type Phase = { name: "idle" } | { name: "sending"; decision: "allow" | "deny" } | { name: "sent" } | { name: "closed"; message: string } | { name: "failed" };

function inputText(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

/** One permission request that waits for an answer. Anyone on the team can answer; the first answer wins. */
export function ApprovalPanel({
  approval,
  hostName,
  onDecide,
}: {
  approval: OpenApproval;
  hostName: string | null;
  onDecide(requestId: string, response: ApprovalResponse): Promise<ApprovalResult>;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [expanded, setExpanded] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");

  const lines = inputText(approval.input).split("\n");
  const long = lines.length > PREVIEW_LINES;
  const shown = expanded || !long ? lines.join("\n") : `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…`;
  const where = hostName ? `Runs on ${hostName}` : "Runs on the owner's computer";
  const busy = phase.name === "sending" || phase.name === "sent";

  async function decide(decision: "allow" | "deny") {
    setPhase({ name: "sending", decision });
    const message = decision === "deny" ? reason.trim() : "";
    try {
      const result = await onDecide(approval.requestId, message ? { decision, message } : { decision });
      if (result.ok) setPhase({ name: "sent" });
      else if (result.error === "failed") setPhase({ name: "failed" });
      else setPhase({ name: "closed", message: closedMessage(result) });
    } catch {
      setPhase({ name: "failed" });
    }
  }

  return (
    <section className="ui-approval" role="group" aria-label={`Permission request: ${approval.tool}`}>
      <div className="ui-approval__head">
        <h2 className="ui-approval__title">
          Claude wants to use <span className="ui-approval__tool">{approval.tool}</span>
        </h2>
        <p className="ui-muted ui-approval__where">{where}</p>
      </div>
      <pre className="ui-approval__input">{shown}</pre>
      {long && (
        <button type="button" className="ui-link ui-approval__more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
      {phase.name === "closed" ? (
        <p className="ui-approval__status" role="status">{phase.message}</p>
      ) : (
        <>
        {reasonOpen && (
          <label className="ui-approval__reason">
            <span className="ui-muted">Tell Claude why (optional)</span>
            <input className="ui-input" value={reason} maxLength={500} disabled={busy} autoFocus onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && void decide("deny")} />
          </label>
        )}
        <div className="ui-approval__actions">
          <button type="button" className="ui-btn ui-btn--primary" disabled={busy} onClick={() => void decide("allow")}>
            {phase.name === "sending" && phase.decision === "allow" ? "Sending…" : "Allow"}
          </button>
          <button type="button" className="ui-btn" disabled={busy} aria-expanded={reasonOpen} onClick={() => (reasonOpen ? void decide("deny") : setReasonOpen(true))}>
            {phase.name === "sending" && phase.decision === "deny" ? "Sending…" : <>Deny <kbd className="ui-kbd">Esc</kbd></>}
          </button>
          {phase.name === "sent" && <span className="ui-muted ui-approval__status" role="status">Sent. Waiting for {hostName ?? "the owner's computer"}…</span>}
          {phase.name === "failed" && <span className="ui-error ui-approval__status" role="alert">Could not send. Try again.</span>}
        </div>
        </>
      )}
    </section>
  );
}
