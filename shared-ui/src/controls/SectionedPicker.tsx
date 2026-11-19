"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { usePopover } from "../live-sessions/usePopover";

export interface PickerOption {
  value: string;
  label: string;
  /** Small text at the end of the row. */
  hint?: string;
  /** Shown but not choosable, such as a harness that is coming soon. */
  disabled?: boolean;
}

export interface PickerSection {
  id: string;
  title: string;
  options: PickerOption[];
  value: string;
  onChange: (value: string) => void;
  /** Leaves the panel open after a choice, for a section whose choice decides what the next section lists. */
  keepOpen?: boolean;
  /** Adds a filter box, for a long list such as timezones. */
  searchable?: boolean;
  /** Lays the options out in one row above the other sections, as tabs. Used for a choice that decides the lists below it. */
  row?: boolean;
}

function SectionOptions({ section, showTitle, autoFocusSelected, onChoose }: {
  section: PickerSection;
  showTitle: boolean;
  autoFocusSelected: boolean;
  onChoose: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const options = needle ? section.options.filter((option) => option.label.toLowerCase().includes(needle)) : section.options;
  return (
    <div className={`ui-picker__section${section.row ? " ui-picker__section--row" : ""}`} role="group" aria-label={section.title}>
      {showTitle && <p className="ui-picker__title">{section.title}</p>}
      {section.searchable && (
        <input
          className="ui-picker__search"
          type="search"
          placeholder="Search"
          aria-label={`Search ${section.title}`}
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="ui-picker__options">
        {options.map((option) => {
          const selected = option.value === section.value;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              aria-disabled={option.disabled || undefined}
              className={`ui-picker__option${option.disabled ? " ui-picker__option--disabled" : ""}`}
              autoFocus={selected && autoFocusSelected && !section.searchable}
              onClick={() => { if (!option.disabled) onChoose(option.value); }}
            >
              <span>{option.label}</span>
              {option.hint && <span className="ui-muted ui-picker__hint">{option.hint}</span>}
              <span className="ui-picker__check" aria-hidden="true">{selected ? "✓" : ""}</span>
            </button>
          );
        })}
        {options.length === 0 && <p className="ui-picker__empty">No matches</p>}
      </div>
    </div>
  );
}

/**
 * One button that opens a panel with several short lists side by side, each with its own title and
 * one selected value. The button shows what the caller passes as `children`.
 */
export function SectionedPicker({ label, children, sections, variant = "compact", disabled, align = "end", direction = "down" }: {
  label: string;
  children: ReactNode;
  sections: PickerSection[];
  /** "field" fills its form column and looks like the other form inputs. */
  variant?: "compact" | "field";
  disabled?: boolean;
  /** Which edge of the button the panel lines up with. "start" lets it grow to the right, as in a form. */
  align?: "start" | "end";
  direction?: "down" | "up";
}) {
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const panelRef = useRef<HTMLDivElement>(null);
  // A click from the keyboard has no pointer, and only then does the panel take focus. A mouse click leaves it on the button.
  const [byKeyboard, setByKeyboard] = useState(false);
  // Lines the panel up with the button, then moves it only as far as it needs to stay inside the window.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    panel.style.marginLeft = "";
    const { left, right } = panel.getBoundingClientRect();
    const edge = 16;
    const shift = right > window.innerWidth - edge ? window.innerWidth - edge - right : left < edge ? edge - left : 0;
    if (shift) panel.style.marginLeft = `${shift}px`;
  }, [open]);
  const rowSection = sections.find((section) => section.row);
  const columnSections = sections.filter((section) => !section.row);

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
    <div className={`ui-picker ui-picker--${variant} ui-picker--align-${align} ui-picker--${direction}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-picker__trigger"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          setByKeyboard(event.detail === 0);
          setOpen((value) => !value);
        }}
      >
        <span className="ui-picker__value">{children}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div className={`ui-picker__panel${rowSection ? " ui-picker__panel--stacked" : ""}`} role="menu" aria-label={label} ref={panelRef} onKeyDown={onPanelKeyDown}>
          {rowSection && <SectionOptions section={rowSection} showTitle={false} autoFocusSelected={false} onChoose={(value) => choose(rowSection, value)} />}
          <div className={rowSection ? "ui-picker__columns" : "ui-picker__columns ui-picker__columns--flat"}>
            {columnSections.map((section) => (
              <SectionOptions
                key={section.id}
                section={section}
                showTitle={sections.length > 1}
                autoFocusSelected={byKeyboard && section === sections.at(-1)}
                onChoose={(value) => choose(section, value)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
