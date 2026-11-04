import { redirect } from "next/navigation";
import { FlowShell } from "draft-shared-ui";
import { AuthForm } from "@/components/AuthForm";
import { getServerIdentity } from "@/lib/server-identity";
import { createOrgPath, parseSignupSource } from "@/lib/signup-source";

export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; src?: string }>;
}) {
  const { invite, src } = await searchParams;
  if (invite) redirect(`/invite/${encodeURIComponent(invite)}`);

  const source = parseSignupSource(src);
  const identity = await getServerIdentity();
  if (identity.state === "ok") {
    const hasOrganization = Boolean(identity.identity.organization_id);
    if (!hasOrganization) redirect(createOrgPath(source));
    redirect(source === "download" ? "/download" : "/");
  }

  return (
    <FlowShell>
      <h1>Create your Draft account</h1>
      <p className="ui-flow__subtitle">Then set up your company and give your team shared context.</p>
      <AuthForm initialMode="signup" allowSignup next={createOrgPath(source)} />
    </FlowShell>
  );
}
