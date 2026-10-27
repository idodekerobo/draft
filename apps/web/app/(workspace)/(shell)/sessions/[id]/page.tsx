"use client";

import Link from "next/link";
import { use } from "react";
import { SessionView } from "draft-shared-ui";
import { useWebLiveSessions } from "@/lib/live-sessions";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { api } = useWebLiveSessions();
  return <SessionView api={api} sessionId={id} back={<Link href="/sessions" className="ui-link">Sessions</Link>} />;
}
