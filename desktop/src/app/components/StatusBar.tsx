// StatusBar.tsx — compact single-line toolbar at the top of the main window
//
// Left:  ● running · N apps connected
// Right: profile-name ▾  (custom dropdown portal)
//
// Dot color thresholds (per DESIGN.md):
//   Green  = running + last capture < 30min ago
//   Yellow = running + last capture 30min–2hr ago, OR daemon degraded
//   Red    = daemon stopped, OR last capture > 2hr ago, OR never synced

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { DaemonStatus } from "../../rpc/schema";

// ── Helpers ────────────────────────────────────────────────────────────────────

type DotVariant = "running" | "degraded" | "stopped";

function getDotVariant(status: DaemonStatus | null): DotVariant {
  if (!status || status.state === "stopped") return "stopped";
  if (status.state === "degraded") return "degraded";
  if (!status.lastSync) return "stopped"; // running but never synced → red

  const diffMins = (Date.now() - new Date(status.lastSync).getTime()) / 60_000;
  if (diffMins < 30)  return "running";
  if (diffMins < 120) return "degraded";
  return "stopped";
}

function getStatusText(status: DaemonStatus | null): string {
  if (!status) return "Connecting…";
  if (status.state === "stopped")  return "not running";
  if (status.state === "degraded") return "degraded";
  return "running";
}

function getConnectedCount(status: DaemonStatus | null): number {
  if (!status?.integrations) return 0;
  return [
    status.integrations.granola,
    status.integrations.slack,
    status.integrations.github,
  ].filter(Boolean).length;
}

// ── Component ──────────────────────────────────────────────────────────────────

interface StatusBarProps {
  status: DaemonStatus | null;
  activeProfile: string;
  profiles: string[];
  onSwitchProfile: (profile: string) => Promise<void>;
}

export function StatusBar({ status, activeProfile, profiles, onSwitchProfile }: StatusBarProps) {
  const [dropdownOpen, setDropdownOpen]   = useState(false);
  const [dropdownPos, setDropdownPos]     = useState<{ top: number; right: number } | null>(null);
  const chipRef     = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const dotVariant      = getDotVariant(status);
  const statusText      = getStatusText(status);
  const connectedCount  = getConnectedCount(status);
  const displayProfile  = activeProfile || "default";

  // ── Open dropdown — calculate position from chip bounds ───────────────────
  function openDropdown() {
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) {
      setDropdownPos({
        top:   rect.bottom + 4,
        right: window.innerWidth - rect.right,
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

  // ── Click-outside to close ────────────────────────────────────────────────
  // Check both the chip button AND the dropdown portal — the portal renders to
  // document.body so it falls outside chipRef, but clicks inside it are not
  // "outside" clicks. Without this guard, mousedown on a dropdown item fires
  // the close handler before the item's onClick can run.
  useEffect(() => {
    if (!dropdownOpen) return;

    function handleMouseDown(e: MouseEvent) {
      const outsideChip     = !chipRef.current?.contains(e.target as Node);
      const outsideDropdown = !dropdownRef.current?.contains(e.target as Node);
      if (outsideChip && outsideDropdown) {
        setDropdownOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [dropdownOpen]);

  // ── Select a profile ──────────────────────────────────────────────────────
  async function handleSelect(profile: string) {
    setDropdownOpen(false);
    await onSwitchProfile(profile);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <header className="status-bar">
      {/* Left: daemon state + integration count */}
      <div className="status-bar__left">
        <span className={`status-bar__dot status-bar__dot--${dotVariant}`} />
        <span className="status-bar__text">{statusText}</span>

        {connectedCount > 0 && (
          <>
            <span className="status-bar__sep">·</span>
            <span className="status-bar__text">
              {connectedCount} {connectedCount === 1 ? "app" : "apps"} connected
            </span>
          </>
        )}
      </div>

      {/* Right: profile chip */}
      <div className="status-bar__right">
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

      {/* Dropdown — rendered via portal so it escapes the status bar's stacking context */}
      {dropdownOpen && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          role="listbox"
          className="profile-dropdown"
          style={{ top: dropdownPos.top, right: dropdownPos.right }}
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
    </header>
  );
}
