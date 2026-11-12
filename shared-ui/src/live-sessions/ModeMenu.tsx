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
 * One mode menu: the current mode as quiet text, and the choices above it. Nothing shows until the host reports a
 * mode. A choice shows as switching until the host reports it. A mode the menu does not list, such as one only a
 * launch flag sets, shows but cannot be changed.
 */
export function ModeMenu({
  label,
  options,
  value,
  switchingTo,
  showLabel,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<HarnessModeOption>;
  value: string | null;
  switchingTo?: string | null;
  showLabel?: boolean;
  onSelect(value: string): void;
}) {
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const current = options.find((o) => o.value === value);
  const shown = switchingTo ? options.find((o) => o.value === switchingTo) : current;
  const locked = value !== null && !current;
  const text = shown?.label ?? (value ? value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) : "");
  if (!text) return null;

  return (
    <div className="ui-mode" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-mode__trigger"
        data-risky={value === "bypassPermissions" || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${text}`}
        disabled={locked || Boolean(switchingTo)}
        onClick={() => setOpen((v) => !v)}
      >
        {showLabel && <span className="ui-mode__label">{label}</span>}
        <span>{switchingTo ? `${text}…` : text}</span>
        <ChevronIcon />
      </button>
      {open && (
        <ul className="ui-mode__list" role="menu" aria-label={label}>
          <li role="none" className="ui-mode__heading">{label}</li>
          {options.map((option) => (
            <li key={option.value} role="none">
              <button type="button" role="menuitemradio" aria-checked={option.value === value} className="ui-mode__item" onClick={() => (setOpen(false), onSelect(option.value))}>
                <span className="ui-mode__name">{option.label}{option.value === value && <CheckIcon />}</span>
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

function ChevronIcon() {
  return (
    <svg className="ui-mode__chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="ui-mode__check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Selected">
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
    </svg>
  );
}
