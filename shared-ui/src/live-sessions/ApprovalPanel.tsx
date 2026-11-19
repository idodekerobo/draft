"use client";

import { useState } from "react";
import { SendStatus, useSend } from "./useSend";
import type { OpenApproval } from "./stream-items";
import type { ApprovalResponse, ApprovalResult } from "./types";

const PREVIEW_LINES = 3;

function inputText(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

/** One permission request that waits for an answer. Anyone on the team can answer; the first answer wins. */
export function ApprovalPanel({
  approval,
  hostName,
  onDecide,
  agent = "Claude",
  explainsDenial = true,
  sleeping = false,
}: {
  approval: OpenApproval;
  hostName: string | null;
  onDecide(requestId: string, response: ApprovalResponse): Promise<ApprovalResult>;
  /** Who is asking, for the title. */
  agent?: string;
  /** Whether the agent reads a reason for a denial. Codex has no field for one. */
  explainsDenial?: boolean;
  /** The session is asleep, so no answer can reach it yet. */
  sleeping?: boolean;
}) {
  const { phase, run, busy, sendingWhat } = useSend();
  const locked = busy || sleeping;
  const [expanded, setExpanded] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");

  const lines = inputText(approval.input).split("\n");
  const long = lines.length > PREVIEW_LINES;
  const shown = expanded || !long ? lines.join("\n") : `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…`;
  const where = hostName ? `Runs on ${hostName}` : "Runs on the owner's computer";

  function decide(decision: "allow" | "deny", scope?: "session") {
    const message = decision === "deny" ? reason.trim() : "";
    return run(scope ? "allow-session" : decision, () => onDecide(approval.requestId, { decision, ...(message ? { message } : {}), ...(scope ? { scope } : {}) }));
  }

  return (
    <section className="ui-approval" role="group" aria-label={`Permission request: ${approval.tool}`}>
      <div className="ui-approval__head">
        <h2 className="ui-approval__title">
          {agent} wants to use <span className="ui-approval__tool">{approval.tool}</span>
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
            <span className="ui-muted">Tell {agent} why (optional)</span>
            <input className="ui-input" value={reason} maxLength={500} disabled={locked} autoFocus onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !locked && void decide("deny")} />
          </label>
        )}
        <div className="ui-approval__actions">
          <button type="button" className="ui-btn ui-btn--primary" disabled={locked} onClick={() => void decide("allow")}>
            {sendingWhat("allow") ? "Sending…" : "Allow"}
          </button>
          {approval.allowSession && (
            <button type="button" className="ui-btn" disabled={locked} onClick={() => void decide("allow", "session")}>
              Allow for session
            </button>
          )}
          <button type="button" className="ui-btn" disabled={locked} aria-expanded={reasonOpen} onClick={() => (reasonOpen || !explainsDenial ? void decide("deny") : setReasonOpen(true))}>
            {sendingWhat("deny") ? "Sending…" : <>Deny <kbd className="ui-kbd">Esc</kbd></>}
          </button>
          <SendStatus phase={phase} hostName={hostName} sleeping={sleeping} />
        </div>
        </>
      )}
    </section>
  );
}
