import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "@/components/AuthForm";
import { ResumeOAuthAuthorize } from "@/components/ResumeOAuthAuthorize";

/** Better Auth's loginPage target — the query is its own signed authorization request, round-tripped unmodified once logged in (see ResumeOAuthAuthorize). */
export default async function OAuthLoginPage({
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
  const queryString = query.toString();

  const client = await createClient();
  const {
    data: { user },
  } = await client.auth.getUser();

  return (
    <main className="card">
      <h1>Connect Draft</h1>
      {user ? (
        <ResumeOAuthAuthorize query={queryString} />
      ) : (
        <>
          <p>Sign in to let this app access your workspace.</p>
          <AuthForm
            next={`/oauth/login?${queryString}`}
            initialMode="login"
          />
        </>
      )}
    </main>
  );
}
