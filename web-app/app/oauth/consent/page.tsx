import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "@/components/AuthForm";
import { ApproveOAuthConsent } from "@/components/ApproveOAuthConsent";

/** Better Auth's consentPage target, reached once logged in and a scope grant needs approval. */
export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => query.append(key, v));
    else if (value !== undefined) query.append(key, value);
  }
  // `error` is our own retry-signal, never part of Better Auth's signed
  // query — strip it before this gets forwarded as oauth_query.
  const hasError = query.has("error");
  query.delete("error");
  const queryString = query.toString();
  const clientId = query.get("client_id") ?? "An application";
  const scope = query.get("scope") ?? "read";

  const client = await createClient();
  const {
    data: { user },
  } = await client.auth.getUser();

  return (
    <main className="card">
      <h1>Connect Draft</h1>
      {hasError && <p className="error">Something went wrong. Try again.</p>}
      {user ? (
        <ApproveOAuthConsent query={queryString} clientId={clientId} scope={scope} />
      ) : (
        <>
          <p>Sign in to continue.</p>
          <AuthForm next={`/oauth/consent?${queryString}`} initialMode="login" />
        </>
      )}
    </main>
  );
}
