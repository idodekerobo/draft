"use client";

import { useState } from "react";
import { renderMarkdown } from "../context/markdown";
import { closedMessage } from "./approval-result";
import type { OpenApproval } from "./stream-items";
import type { ApprovalResponse, ApprovalResult } from "./types";

type Phase = { name: "idle" } | { name: "sending"; what: string } | { name: "sent" } | { name: "closed"; message: string } | { name: "failed" };

/** Modes in which "use auto mode" would change nothing. */
const AUTO_ALREADY = new Set(["auto", "bypassPermissions"]);

/** A plan Claude wants approved. Offers what Claude's own dialog offers. Anyone on the team can answer; the first answer wins. */
export function PlanCard({
  approval,
  hostName,
  onDecide,
  agent = "Claude",
}: {
  approval: OpenApproval;
  hostName: string | null;
  onDecide(requestId: string, response: ApprovalResponse): Promise<ApprovalResult>;
  agent?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [feedback, setFeedback] = useState("");
  const busy = phase.name === "sending" || phase.name === "sent";
  const canAuto = !AUTO_ALREADY.has(approval.permissionMode ?? "");
  const change = feedback.trim();

  async function send(what: string, response: ApprovalResponse) {
    setPhase({ name: "sending", what });
    try {
      const result = await onDecide(approval.requestId, response);
      if (result.ok) setPhase({ name: "sent" });
      else if (result.error === "failed") setPhase({ name: "failed" });
      else setPhase({ name: "closed", message: closedMessage(result) });
    } catch {
      setPhase({ name: "failed" });
    }
  }

  return (
    <section className="ui-approval ui-plan" role="group" aria-label="Plan to approve">
      <div className="ui-approval__head">
        <h2 className="ui-approval__title">{agent} has a plan ready</h2>
        <p className="ui-muted ui-approval__where">Review it, then choose how to go on. {hostName ? `It runs on ${hostName}.` : ""}</p>
      </div>
      <div className="ui-plan__body ui-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(approval.plan ?? "") }} />
      {phase.name === "closed" ? (
        <p className="ui-approval__status" role="status">{phase.message}</p>
      ) : (
        <div className="ui-plan__choices">
          {canAuto && (
            <button type="button" className="ui-btn ui-btn--primary" disabled={busy} onClick={() => void send("auto", { decision: "allow", permissionMode: "auto" })}>
              {phase.name === "sending" && phase.what === "auto" ? "Sending…" : "Yes, and use auto mode"}
            </button>
          )}
          <button type="button" className={`ui-btn${canAuto ? "" : " ui-btn--primary"}`} disabled={busy} onClick={() => void send("manual", { decision: "allow", permissionMode: "default" })}>
            {phase.name === "sending" && phase.what === "manual" ? "Sending…" : "Yes, manually approve edits"}
          </button>
          <label className="ui-plan__feedback">
            <span className="ui-muted">Tell {agent} what to change</span>
            <textarea className="ui-question__other" rows={1} value={feedback} disabled={busy} onChange={(e) => setFeedback(e.target.value)} />
          </label>
          <button type="button" className="ui-btn" disabled={busy || !change} onClick={() => void send("change", { decision: "deny", message: change })}>
            {phase.name === "sending" && phase.what === "change" ? "Sending…" : "Send changes"}
          </button>
          {phase.name === "sent" && <span className="ui-muted ui-approval__status" role="status">Sent. Waiting for {hostName ?? "the owner's computer"}…</span>}
          {phase.name === "failed" && <span className="ui-error ui-approval__status" role="alert">Could not send. Try again.</span>}
        </div>
      )}
    </section>
  );
}
