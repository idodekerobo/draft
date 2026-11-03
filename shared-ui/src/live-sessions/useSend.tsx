"use client";

import { useState } from "react";
import { closedMessage } from "./approval-result";
import type { ApprovalResult } from "./types";

export type SendPhase = { name: "idle" } | { name: "sending"; what: string } | { name: "sent" } | { name: "closed"; message: string } | { name: "failed" };

/** How a decision is going: sending, sent and waiting for the host, too late, or failed. `what` names the choice being sent. */
export function useSend() {
  const [phase, setPhase] = useState<SendPhase>({ name: "idle" });

  async function run(what: string, send: () => Promise<ApprovalResult>) {
    setPhase({ name: "sending", what });
    try {
      const result = await send();
      if (result.ok) setPhase({ name: "sent" });
      else if (result.error === "failed") setPhase({ name: "failed" });
      else setPhase({ name: "closed", message: closedMessage(result) });
    } catch {
      setPhase({ name: "failed" });
    }
  }

  return {
    phase,
    run,
    busy: phase.name === "sending" || phase.name === "sent",
    sendingWhat: (what: string) => phase.name === "sending" && phase.what === what,
  };
}

/** The line next to the buttons once a decision is sent, or could not be. */
export function SendStatus({ phase, hostName }: { phase: SendPhase; hostName: string | null }) {
  if (phase.name === "sent") return <span className="ui-muted ui-approval__status" role="status">Sent. Waiting for {hostName ?? "the owner's computer"}…</span>;
  if (phase.name === "failed") return <span className="ui-error ui-approval__status" role="alert">Could not send. Try again.</span>;
  return null;
}
