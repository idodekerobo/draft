"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/safe-redirect";
import { SiGoogle } from "@icons-pack/react-simple-icons";
export function AuthForm({
  next: nextProp = "/",
  initialMode = "signup",
}: {
  next?: string;
  initialMode?: "signup" | "login";
}) {
  const next = safeNext(nextProp);
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const client = createClient();
    const result =
      mode === "signup"
        ? await client.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
            },
          })
        : await client.auth.signInWithPassword({ email, password });
    if (result.error) {
      setError(result.error.message);
      setBusy(false);
      return;
    }
    if (result.data.session) location.assign(next);
    else {
      setError("Check your email to confirm your account.");
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
          {mode === "signup"
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
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder="At least 6 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <p
          className={error.startsWith("Check your email") ? "status" : "error"}
          role="status"
        >
          {error}
        </p>
      )}
      <button disabled={busy}>
        {busy
          ? "Please wait…"
          : mode === "signup"
            ? "Create Account"
            : "Sign In"}
      </button>
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
    </form>
  );
}
