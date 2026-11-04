import { FlowShell } from "draft-shared-ui";
import { AuthForm } from "@/components/AuthForm";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const p = await searchParams;
  return (
    <FlowShell>
      <h1>Sign in to Draft</h1>
      <AuthForm initialMode="login" next={p.next || "/"} />
      <p className="ui-flow__note">
        New to Draft? <a className="ui-link" href="/signup">Create an account</a>
      </p>
    </FlowShell>
  );
}
