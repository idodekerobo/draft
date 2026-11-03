"use client";

import { useState } from "react";
import { renderMarkdown } from "../context/markdown";
import { SendStatus, useSend } from "./useSend";
import type { OpenApproval } from "./stream-items";
import type { ApprovalResponse, ApprovalResult } from "./types";

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
  const { phase, run, busy, sendingWhat } = useSend();
  const [feedback, setFeedback] = useState("");
  const canAuto = !AUTO_ALREADY.has(approval.permissionMode ?? "");
  const change = feedback.trim();

  const send = (what: string, response: ApprovalResponse) => run(what, () => onDecide(approval.requestId, response));

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
              {sendingWhat("auto") ? "Sending…" : "Yes, and use auto mode"}
            </button>
          )}
          <button type="button" className={`ui-btn${canAuto ? "" : " ui-btn--primary"}`} disabled={busy} onClick={() => void send("manual", { decision: "allow", permissionMode: "default" })}>
            {sendingWhat("manual") ? "Sending…" : "Yes, manually approve edits"}
          </button>
          <label className="ui-plan__feedback">
            <span className="ui-muted">Tell {agent} what to change</span>
            <textarea className="ui-question__other" rows={1} value={feedback} disabled={busy} onChange={(e) => setFeedback(e.target.value)} />
          </label>
          <button type="button" className="ui-btn" disabled={busy || !change} onClick={() => void send("change", { decision: "deny", message: change })}>
            {sendingWhat("change") ? "Sending…" : "Send changes"}
          </button>
          <SendStatus phase={phase} hostName={hostName} />
        </div>
      )}
    </section>
  );
}
