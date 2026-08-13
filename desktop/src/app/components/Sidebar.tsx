// Sidebar.tsx — left navigation panel
//
// Active state: left 2px blue border + slightly lighter bg + white text.
// No icons in colored circles — hairline separator list rows only.

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { DaemonControlVariant, View } from "../types";

interface SidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
  proposalCount: number;
  activeProfile: string;
  profiles: string[];
  onSwitchProfile: (profile: string) => Promise<void>;
  daemonVariant: DaemonControlVariant;
  onStartDaemon: () => void;
  onStopDaemon: () => void;
  onRestartDaemon: () => void;
  onOpenFeedback: () => void;
}

interface NavItem {
  id: View;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "context",   label: "Context"   },
  // TODO: re-enable once the proposal pipeline is wired
  // { id: "proposals", label: "Proposals" },
  { id: "activity",  label: "Activity"  },
  { id: "settings",  label: "Settings"  },
];

type DotClass = "running" | "degraded" | "stopped" | "loading";

interface DaemonControlConfig {
  dotClass: DotClass;
  label: string;
  btnLabel: string | null;
  btnVariant: "stop" | "restart" | "start" | null;
}

const DAEMON_CONTROL_CONFIG: Record<DaemonControlVariant, DaemonControlConfig> = {
  running:    { dotClass: "running",  label: "running",      btnLabel: "Stop",    btnVariant: "stop"    },
  degraded:   { dotClass: "degraded", label: "degraded",     btnLabel: "Restart", btnVariant: "restart" },
  stopped:    { dotClass: "stopped",  label: "not running",  btnLabel: "Start",   btnVariant: "start"   },
  starting:   { dotClass: "loading",  label: "starting…",    btnLabel: null,      btnVariant: null      },
  stopping:   { dotClass: "loading",  label: "stopping…",    btnLabel: null,      btnVariant: null      },
  restarting: { dotClass: "loading",  label: "restarting…",  btnLabel: null,      btnVariant: null      },
};

export function Sidebar({ activeView, onNavigate, proposalCount, activeProfile, profiles, onSwitchProfile, daemonVariant, onStartDaemon, onStopDaemon, onRestartDaemon, onOpenFeedback }: SidebarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPos, setDropdownPos]   = useState<{ bottom: number; left: number } | null>(null);
  const chipRef     = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const displayProfile = activeProfile || "default";
  const cfg = DAEMON_CONTROL_CONFIG[daemonVariant];

  function handleDaemonBtn() {
    if (cfg.btnVariant === "start")   onStartDaemon();
    if (cfg.btnVariant === "stop")    onStopDaemon();
    if (cfg.btnVariant === "restart") onRestartDaemon();
  }

  function openDropdown() {
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) {
      setDropdownPos({
        bottom: window.innerHeight - rect.top + 4,
        left:   rect.left,
      });
    }
    setDropdownOpen(true);
  }

  function toggleDropdown() {
    if (dropdownOpen) {
      setDropdownOpen(false);
    } else {
      openDropdown();
    }
  }

  useEffect(() => {
    if (!dropdownOpen) return;

    function handleMouseDown(e: MouseEvent) {
      const outsideChip     = !chipRef.current?.contains(e.target as Node);
      const outsideDropdown = !dropdownRef.current?.contains(e.target as Node);
      if (outsideChip && outsideDropdown) setDropdownOpen(false);
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [dropdownOpen]);

  async function handleSelect(profile: string) {
    setDropdownOpen(false);
    await onSwitchProfile(profile);
  }

  return (
    <nav className="sidebar">
      <ul className="sidebar__nav" role="tablist">
        {NAV_ITEMS.map((item) => {
          const isActive  = item.id === activeView;
          const showBadge = item.id === "proposals" && proposalCount > 0;

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
            </li>
          );
        })}
      </ul>

      <div className="sidebar__footer">
        <button className="sidebar__feedback" onClick={onOpenFeedback}>
          Questions & Feedback
        </button>
        {/* Hidden: daemon start/stop control doesn't make sense under the
            cloud backend model. Re-enable if local daemon control comes back. */}
        {/* <div className="daemon-control">
          <span className={`daemon-control__dot daemon-control__dot--${cfg.dotClass}`} />
          <span className="daemon-control__label">{cfg.label}</span>
          {cfg.btnVariant && (
            <button
              className={`daemon-control__btn daemon-control__btn--${cfg.btnVariant}`}
              onClick={handleDaemonBtn}
            >
              {cfg.btnLabel}
            </button>
          )}
        </div> */}
        <button
          ref={chipRef}
          className={`profile-chip ${dropdownOpen ? "profile-chip--open" : ""}`}
          onClick={toggleDropdown}
          aria-haspopup="listbox"
          aria-expanded={dropdownOpen}
        >
          {displayProfile}
          <span className="profile-chip__arrow">▾</span>
        </button>
      </div>

      {dropdownOpen && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          role="listbox"
          className="profile-dropdown"
          style={{ bottom: dropdownPos.bottom, left: dropdownPos.left }}
        >
          {profiles.length === 0 ? (
            <div className="profile-dropdown__item profile-dropdown__item--empty">
              {displayProfile}
            </div>
          ) : (
            profiles.map((p) => (
              <button
                key={p}
                role="option"
                aria-selected={p === activeProfile}
                className={`profile-dropdown__item ${p === activeProfile ? "profile-dropdown__item--active" : ""}`}
                onClick={() => void handleSelect(p)}
              >
                <span className="profile-dropdown__check">
                  {p === activeProfile ? "✓" : ""}
                </span>
                <span>{p}</span>
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </nav>
  );
}
