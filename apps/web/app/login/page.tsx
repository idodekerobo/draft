import type { Metadata } from "next";
import { FlowShell } from "draft-shared-ui";
import { AuthForm } from "@/components/AuthForm";
import { sessionIdFromNext, sessionPageTitle } from "@/lib/session-title";
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ next?: string }> }): Promise<Metadata> {
  const sessionId = sessionIdFromNext((await searchParams).next);
  if (!sessionId) return {};
  const title = await sessionPageTitle(sessionId);
  return { title, openGraph: { title } };
}

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
      <p className="auth-switch">
        New to Draft? <a className="ui-link" href="/signup">Create an account</a>
      </p>
    </FlowShell>
  );
}
