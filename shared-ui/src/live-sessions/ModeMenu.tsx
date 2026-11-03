"use client";

import { useCallback, useEffect, useState } from "react";
import type { HarnessModeOption } from "draft-core/harnesses";
import { usePopover } from "./usePopover";

/** How long a chosen mode shows as switching before the chat gives up waiting for the host to report it. */
const SWITCH_WAIT_MS = 8_000;

/** The option after `current` in menu order, wrapping. This is the Shift+Tab order. */
export function nextMode(options: ReadonlyArray<HarnessModeOption>, current: string | null | undefined): string | null {
  if (options.length === 0) return null;
  const index = options.findIndex((o) => o.value === current);
  return options[(index + 1) % options.length]!.value;
}

/**
 * One mode menu: the current mode as a button, and the choices above it. A choice shows as switching until the
 * host reports it. A mode the menu does not list, such as one only a launch flag sets, shows but cannot be changed.
 */
export function ModeMenu({
  label,
  options,
  value,
  switchingTo,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<HarnessModeOption>;
  value: string | null;
  switchingTo?: string | null;
  onSelect(value: string): void;
}) {
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const current = options.find((o) => o.value === value);
  const shown = switchingTo ? options.find((o) => o.value === switchingTo) : current;
  const locked = value !== null && !current;
  const text = shown?.label ?? (value ? value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) : "Mode");

  return (
    <div className="ui-mode" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-btn ui-mode__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${text}`}
        disabled={locked || Boolean(switchingTo)}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ui-muted">{label}</span> <strong>{switchingTo ? `${text}…` : text}</strong>
      </button>
      {open && (
        <ul className="ui-mode__list" role="menu" aria-label={label}>
          {options.map((option) => (
            <li key={option.value} role="none">
              <button type="button" role="menuitemradio" aria-checked={option.value === value} className="ui-mode__item" onClick={() => (setOpen(false), onSelect(option.value))}>
                <span className="ui-mode__name">{option.label}{option.value === value ? " ✓" : ""}</span>
                <span className="ui-mode__desc">{option.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tracks a mode the person just chose, until the session reports it or the wait runs out. */
export function useSwitching(actual: string | null | undefined): { target: string | null; start(value: string): void; clear(): void } {
  const [target, setTarget] = useState<string | null>(null);
  const start = useCallback((value: string) => setTarget(value), []);
  const clear = useCallback(() => setTarget(null), []);
  useEffect(() => {
    if (target !== null && actual === target) setTarget(null);
  }, [actual, target]);
  useEffect(() => {
    if (target === null) return;
    const timer = setTimeout(() => setTarget(null), SWITCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [target]);
  return { target, start, clear };
}
