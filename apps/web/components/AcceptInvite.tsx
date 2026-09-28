"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { API_URL, DOWNLOAD_URL } from "@/lib/config";
export function AcceptInvite({ token }: { token: string }) {
  const [state, setState] = useState("joining");
  useEffect(() => {
    void (async () => {
      const {
        data: { session },
      } = await createClient().auth.getSession();
      if (!session) {
        setState("signed_out");
        return;
      }
      const r = await fetch(
        `${API_URL}/invites/${encodeURIComponent(token)}/accept`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );
      if (r.ok) setState("done");
      else {
        const b = await r.json();
        setState(b.error || "failed");
      }
    })();
  }, [token]);
  if (state === "signed_out") return null;
  if (state === "done")
    return (
      <>
        <p>You’re in. Download Draft to get started.</p>
        <a className="button" href={DOWNLOAD_URL}>
          Download Draft for macOS
        </a>
      </>
    );
  if (state === "already_in_another_organization")
    return (
      <p className="error">
        You’re already part of another organization. Contact the founder to move
        workspaces.
      </p>
    );
  if (state !== "joining")
    return (
      <p className="error">We couldn’t accept this invitation ({state}).</p>
    );
  return <p>Joining your workspace…</p>;
}
