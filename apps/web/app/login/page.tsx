import { AuthForm } from "@/components/AuthForm";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const p = await searchParams;
  return (
    <main className="card">
      <h1>Sign in to Draft</h1>
      <AuthForm initialMode="login" next={p.next || "/"} />
    </main>
  );
}
