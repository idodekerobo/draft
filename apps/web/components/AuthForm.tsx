"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/safe-redirect";
import { SiGoogle } from "@icons-pack/react-simple-icons";
import { WaitingForEmail } from "@/components/WaitingForEmail";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
export function AuthForm({
  next: nextProp = "/",
  initialMode = "login",
  allowSignup = false,
}: {
  next?: string;
  initialMode?: "signup" | "login";
  allowSignup?: boolean;
}) {
  const next = safeNext(nextProp);
  const [mode, setMode] = useState(allowSignup ? initialMode : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const { track } = useAnalytics();
  const emailRedirectTo = typeof location === "undefined" ? "" : `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const client = createClient();
    const result =
      allowSignup && mode === "signup"
        ? await client.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo,
            },
          })
        : await client.auth.signInWithPassword({ email, password });
    if (result.error) {
      setError(result.error.message);
      setBusy(false);
      return;
    }
    if (allowSignup && mode === "signup") track("account_created", { method: "email" });
    if (result.data.session) location.assign(next);
    else {
      setWaiting(true);
      setBusy(false);
    }
  }
  async function google() {
    setBusy(true);
    const client = createClient();
    const result = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (result.error) {
      setError(result.error.message);
      setBusy(false);
    }
  }
  if (waiting) {
    return (
      <WaitingForEmail
        email={email}
        password={password}
        next={next}
        emailRedirectTo={emailRedirectTo}
        onBack={() => { setWaiting(false); setPassword(""); }}
      />
    );
  }
  return (
    <form onSubmit={submit}>
      <button
        type="button"
        className="google-button"
        onClick={google}
        disabled={busy}
      >
        <SiGoogle size={18} color="default" aria-hidden="true" />
        Sign in with Google
      </button>
      <div className="auth-divider" aria-hidden="true">
        <span />
        <small>
          {allowSignup && mode === "signup"
            ? "or create an account with email"
            : "or sign in with email"}
        </small>
        <span />
      </div>
      <label>
        Email
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          minLength={6}
          required
          autoComplete={allowSignup && mode === "signup" ? "new-password" : "current-password"}
          placeholder="At least 6 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button disabled={busy}>
        {busy
          ? "Please wait…"
          : allowSignup && mode === "signup"
            ? "Create account"
            : "Sign in"}
      </button>
      {allowSignup && (
        <button
          type="button"
          className="mode-switch"
          disabled={busy}
          onClick={() => setMode(mode === "signup" ? "login" : "signup")}
        >
          {mode === "signup"
            ? "Already have an account? Sign in"
            : "Need an account? Sign up"}
        </button>
      )}
    </form>
  );
}
