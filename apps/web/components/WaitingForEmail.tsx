"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const FIRST_DELAY_MS = 3_000;
const MAX_DELAY_MS = 15_000;

/**
 * Continues by itself once the email is confirmed on any device.
 * The password lives only in this component's props and is dropped on unmount.
 */
export function WaitingForEmail({ email, password, next, emailRedirectTo, onBack }: {
  email: string;
  password: string;
  next: string;
  emailRedirectTo: string;
  onBack: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const delay = useRef(FIRST_DELAY_MS);

  async function trySignIn(): Promise<boolean> {
    const { data, error } = await createClient().auth.signInWithPassword({ email, password });
    if (data.session) {
      location.assign(next);
      return true;
    }
    if (error && !/not confirmed/i.test(error.message)) {
      setNote(error.status === 429 ? "Still waiting. Press Continue once you have confirmed." : error.message);
    }
    return false;
  }

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled || await trySignIn()) return;
      delay.current = Math.min(delay.current * 2, MAX_DELAY_MS);
      timer = setTimeout(() => void tick(), delay.current);
    };
    timer = setTimeout(() => void tick(), delay.current);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  async function continueNow() {
    setChecking(true);
    if (!await trySignIn()) setNote((current) => current ?? "Your email is not confirmed yet. Open the link in the email first.");
    setChecking(false);
  }

  async function resend() {
    const { error } = await createClient().auth.resend({ type: "signup", email, options: { emailRedirectTo } });
    setNote(error ? error.message : "We sent a new link.");
  }

  return (
    <div role="status">
      <h1>Check your email</h1>
      <p>We sent a link to <strong>{email}</strong>. Open it on any device. This page continues by itself once you confirm.</p>
      <div className="consent-actions">
        <button type="button" className="ui-btn ui-btn--primary" onClick={() => void continueNow()} disabled={checking}>
          {checking ? "Checking…" : "Continue"}
        </button>
        <button type="button" className="ui-link" onClick={() => void resend()}>Send a new link</button>
        <button type="button" className="ui-link" onClick={onBack}>Use a different email</button>
      </div>
      {note && <p className="status">{note}</p>}
    </div>
  );
}
