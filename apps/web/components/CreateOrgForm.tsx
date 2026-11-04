"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FlowShell, type SignupSource } from "draft-shared-ui";
import { ApiError, apiFetch } from "@/lib/api";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import type { Identity } from "@/lib/identity";
import { ORG_NAME_KEY } from "@/lib/workspace";

type FailureReason = "invalid_name" | "already_in_organization" | "network" | "server";

const FAILURE_COPY: Record<Exclude<FailureReason, "already_in_organization">, string> = {
  invalid_name: "Enter a company name of up to 80 characters.",
  network: "Could not reach Draft. Check your connection and try again.",
  server: "We could not create your company. Try again.",
};

function failureReason(error: unknown): FailureReason {
  if (!(error instanceof ApiError)) return "server";
  if (error.status === 0) return "network";
  if (error.status === 400) return "invalid_name";
  if (error.status === 409) return "already_in_organization";
  return "server";
}

export function CreateOrgForm({ identity, source, destination }: { identity: Identity; source: SignupSource; destination: string }) {
  const router = useRouter();
  const { track, syncUser } = useAnalytics();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // This page sits outside the workspace layout, so consent is applied here for the events below.
    syncUser(identity);
    track("org_create_viewed", { source });
  }, [identity, source, syncUser, track]);

  function finish(organizationName: string) {
    try { sessionStorage.setItem(ORG_NAME_KEY, organizationName); } catch {}
    router.replace(destination);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError("");
    setBusy(true);
    try {
      await apiFetch("/organizations", { method: "POST", body: JSON.stringify({ name: trimmed }) });
      track("org_created", { source });
      finish(trimmed);
    } catch (caught) {
      const reason = failureReason(caught);
      // A double submit or a second tab already created it, so carry on.
      if (reason === "already_in_organization") return finish(trimmed);
      track("org_create_failed", { reason });
      setError(FAILURE_COPY[reason]);
      setBusy(false);
    }
  }

  return (
    <FlowShell>
      <h1>Name your company</h1>
      <p className="ui-flow__subtitle">This is the home for your team&apos;s shared context. You can invite people next.</p>
      <form onSubmit={submit}>
        <label>
          Company name
          <input
            type="text"
            required
            maxLength={80}
            autoFocus
            autoComplete="organization"
            placeholder="Acme Inc."
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy || !name.trim()}>{busy ? "Creating…" : "Continue"}</button>
      </form>
    </FlowShell>
  );
}
