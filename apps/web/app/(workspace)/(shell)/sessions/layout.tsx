"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { SessionsLayout } from "draft-shared-ui";
import { useWebLiveSessions } from "@/lib/live-sessions";

export default function SessionsSectionLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const selectedId = /^\/sessions\/([^/]+)/.exec(usePathname())?.[1] ?? null;
  const { sessions, enabled, isPending, isError } = useWebLiveSessions();

  if (!isPending && !enabled) {
    return (
      <div className="ui-page">
        <h1 className="ui-page__title">Sessions</h1>
        <p className="ui-muted">Live sessions are not turned on for this workspace.</p>
      </div>
    );
  }
  return (
    <SessionsLayout sessions={sessions} loading={isPending} failed={isError} selectedId={selectedId} onSelect={(id) => router.push(`/sessions/${id}`)}>
      {children}
    </SessionsLayout>
  );
}
