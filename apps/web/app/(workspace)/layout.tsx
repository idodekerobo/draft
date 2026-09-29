import { redirect } from "next/navigation";
import { FlowShell } from "draft-shared-ui";
import { getServerIdentity } from "@/lib/server-identity";
import { WorkspaceProvider } from "@/lib/workspace";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const result = await getServerIdentity();
  if (result.state === "signed_out") redirect("/login?next=/");
  if (result.state === "api_down") {
    return (
      <FlowShell>
        <h1>Draft is not responding</h1>
        <p>We could not load your workspace. Try again in a moment.</p>
        <a className="ui-btn ui-btn--primary" href="/">Try again</a>
      </FlowShell>
    );
  }
  const { identity } = result;
  if (!identity.organization_id || !identity.workspace_id) {
    // TODO: self-serve org creation replaces this dead end.
    return (
      <FlowShell>
        <h1>You&apos;re signed in</h1>
        <p>Ask your workspace admin for an invite link to join your team.</p>
      </FlowShell>
    );
  }
  return <WorkspaceProvider identity={{ ...identity, workspace_id: identity.workspace_id }}>{children}</WorkspaceProvider>;
}
