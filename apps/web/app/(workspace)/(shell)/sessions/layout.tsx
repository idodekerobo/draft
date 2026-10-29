"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { SessionsLayout } from "draft-shared-ui";
import { useWebLiveSessions } from "@/lib/live-sessions";
import { SessionEntryProvider, useSessionEntry } from "@/lib/session-entry";

export default function SessionsSectionLayout({ children }: { children: ReactNode }) {
  const selectedId = /^\/sessions\/([^/]+)/.exec(usePathname())?.[1] ?? null;
  return (
    <SessionEntryProvider firstSessionId={selectedId}>
      <SessionsSection selectedId={selectedId}>{children}</SessionsSection>
    </SessionEntryProvider>
  );
}

function SessionsSection({ selectedId, children }: { selectedId: string | null; children: ReactNode }) {
  const router = useRouter();
  const { markInAppNavigation } = useSessionEntry();
  const { sessions, isPending, isError } = useWebLiveSessions();

  return (
    <SessionsLayout sessions={sessions} loading={isPending} failed={isError} selectedId={selectedId} onSelect={(id) => {
        markInAppNavigation();
        router.push(`/sessions/${id}`);
      }}>
      {children}
    </SessionsLayout>
  );
}
