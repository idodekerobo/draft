import { createClient } from "@/lib/supabase/server";
import { API_URL } from "@/lib/config";
import { redirect } from "next/navigation";
export default async function Home() {
  const client = await createClient();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) redirect("/signup");
  const r = await fetch(`${API_URL}/whoami`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: "no-store",
  });
  const user = r.ok ? await r.json() : null;
  return (
    <main className="card">
      <h1>Account created</h1>
      {user?.organization_id ? (
        <p>You’re connected to your team workspace.</p>
      ) : (
        <p>Ask your workspace admin for an invite link to join your team.</p>
      )}
    </main>
  );
}
