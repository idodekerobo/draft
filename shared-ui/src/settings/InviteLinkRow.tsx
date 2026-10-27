"use client";

import { useCallback, useEffect, useState } from "react";
import { CopyableCmd } from "../onboarding/components";
import { SettingsRow } from "./SettingsRow";

export interface InviteLink {
  url: string | null;
  expiresAt: string | null;
}

type State = { kind: "loading" } | { kind: "ready"; invite: InviteLink } | { kind: "creating" } | { kind: "error" };

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** Renders a list item; place inside a `ui-rows` list. `loadInvite(false)` only looks, `loadInvite(true)` creates a link when none is active. */
export function InviteLinkRow({ loadInvite }: { loadInvite: (createIfMissing: boolean) => Promise<InviteLink> }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const run = useCallback(
    async (createIfMissing: boolean) => {
      setState(createIfMissing ? { kind: "creating" } : { kind: "loading" });
      try {
        setState({ kind: "ready", invite: await loadInvite(createIfMissing) });
      } catch {
        setState({ kind: "error" });
      }
    },
    [loadInvite],
  );

  useEffect(() => {
    void run(false);
  }, [run]);

  const invite = state.kind === "ready" ? state.invite : null;
  const url = invite?.url ?? null;

  let helper = "Create a link that lets people join your team.";
  if (state.kind === "loading") helper = "Checking for an invite link…";
  if (state.kind === "error") helper = "Could not load the invite link.";
  if (url) helper = `Anyone with this link can join your team.${invite?.expiresAt ? ` It expires ${formatDate(invite.expiresAt)}.` : ""}`;

  return (
    <li>
      <SettingsRow
        label="Invite teammates"
        helper={helper}
        control={
          url ? null : state.kind === "loading" ? null : (
            <button type="button" className="ui-btn" disabled={state.kind === "creating"} onClick={() => void run(state.kind !== "error")}>
              {state.kind === "creating" ? "Creating…" : state.kind === "error" ? "Try again" : "Create invite link"}
            </button>
          )
        }
      />
      {url && (
        <div className="ui-invite__link">
          <CopyableCmd cmd={url} />
        </div>
      )}
    </li>
  );
}
