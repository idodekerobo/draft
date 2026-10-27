// Sidebar.tsx — left navigation panel
//
// Active state uses the shared selection and focus tokens.
// No icons in colored circles — hairline separator list rows only.

import { Brand, mainNavItems } from "draft-shared-ui";
import { memo } from "react";
import type { View } from "../types";

interface SidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
  onOpenFeedback: () => void;
  sessionsEnabled: boolean;
}

export const Sidebar = memo(function Sidebar({ activeView, onNavigate, onOpenFeedback, sessionsEnabled }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar__brand"><Brand /></div>
      <ul className="sidebar__nav">
        {mainNavItems(sessionsEnabled).map((item) => {
          const isActive = item.id === activeView;

          return (
            <li key={item.id}>
              <button type="button" className={`ui-shell__link sidebar__item${isActive ? " sidebar__item--active" : ""}`} aria-current={isActive ? "page" : undefined} onClick={() => onNavigate(item.id)}>
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="sidebar__footer">
        <button className="sidebar__feedback" onClick={onOpenFeedback}>
          Questions & Feedback
        </button>
      </div>
    </nav>
  );
});
