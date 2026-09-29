import { FlowShell } from "draft-shared-ui";
import { safeNext } from "@/lib/safe-redirect";

export default async function EmailConfirmed({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  return (
    <FlowShell>
      <h1>Email confirmed</h1>
      <p>Return to your other device. It continues by itself. Or continue here.</p>
      <a className="ui-btn ui-btn--primary" href={`/login?next=${encodeURIComponent(next)}`}>Continue here</a>
    </FlowShell>
  );
}
