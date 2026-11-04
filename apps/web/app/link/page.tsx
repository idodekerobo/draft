import { redirect } from "next/navigation";
import { FlowShell } from "draft-shared-ui";
import { getServerIdentity } from "@/lib/server-identity";
import { createOrgPath } from "@/lib/signup-source";
import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "@/components/AuthForm";
import { ApprovePairing } from "@/components/ApprovePairing";
import type { ReactNode } from "react";

function PairingPanel({ title, description, children }: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="pairing-page">
      <FlowShell>
        <section className="pairing-panel" aria-labelledby="pairing-title">
          <div className="pairing-panel__icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="12" rx="2" />
              <path d="M8 20h8M12 16v4" />
            </svg>
          </div>
          <h1 id="pairing-title" className="ui-flow__title">{title}</h1>
          <p className="ui-flow__subtitle">{description}</p>
          {children}
        </section>
      </FlowShell>
    </div>
  );
}

export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  if (!code)
    return (
      <PairingPanel
        title="Invalid pairing link"
        description="Open a new sign-in link from Draft to connect your device."
      />
    );
  const client = await createClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (user) {
    const result = await getServerIdentity();
    // No company yet: create one first, then come back here to approve.
    if (result.state === "ok" && !result.identity.organization_id) {
      redirect(createOrgPath("desktop", `/link?code=${encodeURIComponent(code)}`));
    }
  }
  return (
    <PairingPanel
      title="Connect Draft"
      description={user
        ? "Connect your local CLI or desktop app to your Draft account."
        : "Sign in or create an account to connect your local CLI or desktop app to Draft."}
    >
      <div className="pairing-panel__actions">
        {user ? (
          <ApprovePairing code={code} />
        ) : (
          <AuthForm
            next={`/link?code=${encodeURIComponent(code)}`}
            initialMode="login"
            allowSignup
          />
        )}
      </div>
      <p className="pairing-panel__note">You can close this tab after connecting.</p>
    </PairingPanel>
  );
}
