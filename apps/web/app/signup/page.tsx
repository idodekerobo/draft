import { redirect } from "next/navigation";

export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const { invite } = await searchParams;
  redirect(invite ? `/invite/${encodeURIComponent(invite)}` : "/login");
}
