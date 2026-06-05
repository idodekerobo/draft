// Sidebar.tsx — left navigation panel
//
// Active state: left 2px blue border + slightly lighter bg + white text.
// No icons in colored circles — hairline separator list rows only.

import type { View } from "../types";

interface SidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
  proposalCount: number;
  contextHasNew: boolean;
}

interface NavItem {
  id: View;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "context",   label: "Context"   },
  { id: "proposals", label: "Proposals" },
  { id: "settings",  label: "Settings"  },
];

export function Sidebar({ activeView, onNavigate, proposalCount, contextHasNew }: SidebarProps) {
  return (
    <nav className="sidebar">
      <ul className="sidebar__nav" role="tablist">
        {NAV_ITEMS.map((item) => {
          const isActive = item.id === activeView;
          const showBadge = item.id === "proposals" && proposalCount > 0;
          const showDot = item.id === "context" && contextHasNew && !isActive;

          return (
            <li
              key={item.id}
              className={`sidebar__item${isActive ? " sidebar__item--active" : ""}`}
              role="tab"
              aria-selected={isActive}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
              {showBadge && (
                <span className="sidebar__badge" aria-label={`${proposalCount} pending`}>
                  {proposalCount > 99 ? "99+" : proposalCount}
                </span>
              )}
              {showDot && (
                <span className="sidebar__dot" aria-label="New team context" />
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
