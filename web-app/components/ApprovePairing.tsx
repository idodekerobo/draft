"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { API_URL } from "@/lib/config";
export function ApprovePairing({ code }: { code: string }) {
  const [state, setState] = useState("ready");
  async function approve() {
    setState("working");
    const {
      data: { session },
    } = await createClient().auth.getSession();
    if (!session) {
      setState("error");
      return;
    }
    const r = await fetch(
      `${API_URL}/link/${encodeURIComponent(code)}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          expires_in: session.expires_in,
        }),
      },
    );
    setState(r.ok ? "done" : "error");
  }
  if (state === "done")
    return <p>Your device is signed in. You can close this window.</p>;
  return (
    <>
      <button disabled={state === "working"} onClick={approve}>
        Approve sign-in
      </button>
      {state === "error" && (
        <p className="error">This pairing code is invalid or expired.</p>
      )}
    </>
  );
}
