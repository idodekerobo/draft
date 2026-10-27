"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand, mainNavItems, useQuery } from "draft-shared-ui";
import { apiFetch } from "@/lib/api";
import { useWebLiveSessions } from "@/lib/live-sessions";
import { contextQueryOptions } from "@/lib/queries";
import { useWorkspace } from "@/lib/workspace";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { identity, workspaceId, seenContextVersion } = useWorkspace();
  const { data: snapshot } = useQuery(contextQueryOptions(workspaceId, apiFetch));
  const { enabled: sessionsEnabled } = useWebLiveSessions();
  const navItems = mainNavItems(sessionsEnabled).map((item) => ({ ...item, href: `/${item.id}` }));
  const hasUnseenContext = snapshot != null && seenContextVersion !== null && snapshot.versionNumber > seenContextVersion;
  return (
    <div className="ui-shell">
      <nav className="ui-shell__nav" aria-label="Main">
        <Link className="ui-wordmark" href="/"><Brand /></Link>
        <ul>
          {navItems.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link className={`ui-shell__link${active ? " ui-shell__link--active" : ""}`} href={item.href} aria-current={active ? "page" : undefined}>
                  {item.label}
                  {item.href === "/context" && hasUnseenContext && !active && (
                    <span className="ui-shell__unseen" role="img" aria-label="New context" />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        <span className="ui-shell__footer" title={identity.email}>{identity.email}</span>
      </nav>
      <main className="ui-shell__main">{children}</main>
    </div>
  );
}
