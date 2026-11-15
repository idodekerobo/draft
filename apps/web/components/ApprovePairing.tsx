"use client";
import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { API_URL } from "@/lib/config";
import { normalizeConfirmCode } from "@/lib/confirm-code";

interface SignInInfo {
  client: string;
  requested_at: string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "failed"; message: string }
  | { kind: "ready" | "working"; error?: string }
  | { kind: "done" };

const INVALID_MESSAGE = "This sign-in link is invalid or expired.";

async function accessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await createClient().auth.getSession();
  return session?.access_token ?? null;
}

export function ApprovePairing({ code }: { code: string }) {
  const [info, setInfo] = useState<SignInInfo | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [confirmInput, setConfirmInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = await accessToken();
      if (!token) return setPhase({ kind: "invalid" });
      const r = await fetch(`${API_URL}/link/${encodeURIComponent(code)}/info`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (cancelled) return;
      if (r.status === 404) return setPhase({ kind: "invalid" });
      if (!r.ok) return setPhase({ kind: "failed", message: "Could not load this sign-in. Try again." });
      setInfo((await r.json()) as SignInInfo);
      setPhase({ kind: "ready" });
    }
    load().catch(() => {
      if (!cancelled) setPhase({ kind: "failed", message: "Could not load this sign-in. Try again." });
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPhase({ kind: "working" });
    const token = await accessToken();
    if (!token) return setPhase({ kind: "invalid" });
    const r = await fetch(`${API_URL}/link/${encodeURIComponent(code)}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm_code: normalizeConfirmCode(confirmInput) }),
    });
    if (r.ok) return setPhase({ kind: "done" });
    if (r.status === 404) return setPhase({ kind: "invalid" });
    if (r.status === 400) return setPhase({ kind: "ready", error: "That code doesn't match. Check your terminal and try again." });
    setPhase({ kind: "ready", error: "Could not approve this sign-in. Try again." });
  }

  if (phase.kind === "done")
    return <p>Your device is signed in. Return to the Draft app to continue setup. You can close this window.</p>;
  if (phase.kind === "loading") return <p>Loading sign-in request…</p>;
  if (phase.kind === "invalid") return <p className="error">{INVALID_MESSAGE}</p>;
  if (phase.kind === "failed") return <p className="error">{phase.message}</p>;

  const requestedAt = info ? new Date(info.requested_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  const working = phase.kind === "working";
  const codeReady = normalizeConfirmCode(confirmInput).length === 6;

  return (
    <form onSubmit={approve}>
      <p>Sign-in requested by {info?.client} at {requestedAt}.</p>
      <label htmlFor="confirm-code">Type the code shown in your terminal or app</label>
      <input
        id="confirm-code"
        name="confirm-code"
        type="text"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={7}
        placeholder="K7M-4QX"
        value={confirmInput}
        onChange={(event) => setConfirmInput(event.target.value)}
        disabled={working}
      />
      <p className="pairing-panel__note">Only approve a sign-in you started yourself. If someone sent you this link, don't approve it.</p>
      <button type="submit" disabled={working || !codeReady}>
        Approve sign-in
      </button>
      {phase.error && <p className="error">{phase.error}</p>}
    </form>
  );
}
