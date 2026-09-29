import { FlowShell } from "draft-shared-ui";
import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "@/components/AuthForm";
import { ApprovePairing } from "@/components/ApprovePairing";
export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  if (!code)
    return (
      <FlowShell>
        <h1>Invalid pairing link</h1>
      </FlowShell>
    );
  const client = await createClient();
  const {
    data: { user },
  } = await client.auth.getUser();
  return (
    <FlowShell>
      <h1>Connect Draft</h1>
      {user ? (
        <ApprovePairing code={code} />
      ) : (
        <>
          <p>Sign in or create an account to continue.</p>
          <AuthForm
            next={`/link?code=${encodeURIComponent(code)}`}
            initialMode="login"
          />
        </>
      )}
    </FlowShell>
  );
}
