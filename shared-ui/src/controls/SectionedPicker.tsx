"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { usePopover } from "../live-sessions/usePopover";

export interface PickerOption {
  value: string;
  label: string;
  /** Small text at the end of the row. */
  hint?: string;
}

export interface PickerSection {
  id: string;
  title: string;
  options: PickerOption[];
  value: string;
  onChange: (value: string) => void;
  /** Leaves the panel open after a choice, for a section whose choice decides what the next section lists. */
  keepOpen?: boolean;
}

/**
 * One button that opens a panel with several short lists side by side, each with its own title and
 * one selected value. The button shows what the caller passes as `children`.
 */
export function SectionedPicker({ label, children, sections }: { label: string; children: ReactNode; sections: PickerSection[] }) {
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const panelRef = useRef<HTMLDivElement>(null);

  function choose(section: PickerSection, value: string) {
    section.onChange(value);
    if (section.keepOpen) return;
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="ui-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-picker__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div className="ui-picker__panel" role="menu" aria-label={label} ref={panelRef} onKeyDown={onPanelKeyDown}>
          {sections.map((section) => (
            <div key={section.id} className="ui-picker__section" role="group" aria-label={section.title}>
              <p className="ui-picker__title">{section.title}</p>
              {section.options.map((option) => {
                const selected = option.value === section.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="ui-picker__option"
                    autoFocus={selected && section === sections.at(-1)}
                    onClick={() => choose(section, option.value)}
                  >
                    <span>{option.label}</span>
                    {option.hint && <span className="ui-muted ui-picker__hint">{option.hint}</span>}
                    <span className="ui-picker__check" aria-hidden="true">{selected ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
