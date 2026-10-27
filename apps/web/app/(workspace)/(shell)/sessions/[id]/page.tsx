"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";
import { SessionView } from "draft-shared-ui";
import { useWebLiveSessions } from "@/lib/live-sessions";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { api } = useWebLiveSessions();
  const router = useRouter();
  return (
    <SessionView
      api={api}
      sessionId={id}
      back={<Link href="/sessions" className="ui-link">Sessions</Link>}
      onOpenSession={(sessionId) => router.push(`/sessions/${sessionId}`)}
    />
  );
}
