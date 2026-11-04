import { redirect } from "next/navigation";
import { FlowShell } from "draft-shared-ui";
import { CreateOrgForm } from "@/components/CreateOrgForm";
import { safeNext } from "@/lib/safe-redirect";
import { getServerIdentity } from "@/lib/server-identity";
import { createOrgPath, parseSignupSource } from "@/lib/signup-source";

export default async function CreateOrganization({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; src?: string }>;
}) {
  const { next, src } = await searchParams;
  const source = parseSignupSource(src);
  const destination = safeNext(next, "/welcome");

  const result = await getServerIdentity();
  if (result.state === "signed_out") {
    redirect(`/login?next=${encodeURIComponent(createOrgPath(source, next))}`);
  }
  if (result.state === "api_down") {
    return (
      <FlowShell>
        <h1>Draft is not responding</h1>
        <p>We could not load your account. Try again in a moment.</p>
        <a className="ui-btn ui-btn--primary" href={createOrgPath(source, next)}>Try again</a>
      </FlowShell>
    );
  }

  const { identity } = result;
  if (identity.organization_id && identity.workspace_id) redirect(destination);
  if (identity.organization_id) {
    return (
      <FlowShell>
        <h1>Your team has no workspace yet</h1>
        <p>Ask your workspace admin to finish setting up your team.</p>
      </FlowShell>
    );
  }

  return <CreateOrgForm identity={identity} source={source} destination={destination} />;
}
