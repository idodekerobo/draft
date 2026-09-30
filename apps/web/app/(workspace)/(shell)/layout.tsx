import { redirect } from "next/navigation";
import { getServerIdentity } from "@/lib/server-identity";
import { AppShell } from "@/components/AppShell";

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const result = await getServerIdentity();
  if (result.state === "ok" && !result.identity.onboarding_completed_at) redirect("/welcome");
  return <AppShell>{children}</AppShell>;
}
