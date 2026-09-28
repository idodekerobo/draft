import { AuthForm } from "@/components/AuthForm";
export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  const next = invite ? `/invite/${encodeURIComponent(invite)}` : "/";
  return (
    <main className="card">
      <h1>Create your Draft account</h1>
      <AuthForm next={next} />
    </main>
  );
}
