import type { Metadata } from "next";
import { sessionPageTitle } from "@/lib/session-title";
import { SessionPageClient } from "./session-page-client";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const title = await sessionPageTitle((await params).id);
  return { title, openGraph: { title } };
}

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  return <SessionPageClient params={params} />;
}
