import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { ThemePreference } from "./theme";

export function SettingsRow({ label, helper, control, labelId }: { label: string; helper?: ReactNode; control: ReactNode; labelId?: string }) {
  return (
    <div className="ui-settings-row">
      <div className="ui-settings-row__text">
        <span className="ui-settings-row__label" id={labelId}>{label}</span>
        {helper && <span className="ui-settings-row__helper">{helper}</span>}
      </div>
      <div className="ui-settings-row__control">{control}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, labelledBy }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; labelledBy?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className={`ui-toggle${checked ? " ui-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle__thumb" />
    </button>
  );
}

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function AppearanceRow({ value, onChange }: { value: ThemePreference; onChange: (next: ThemePreference) => void }) {
  const labelId = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent, index: number) {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    onChange(THEME_OPTIONS[next]!.value);
    buttons.current[next]?.focus();
  }

  return (
    <SettingsRow
      label="Appearance"
      labelId={labelId}
      helper="System follows your computer's setting."
      control={
        <div className="ui-segmented" role="radiogroup" aria-labelledby={labelId}>
          {THEME_OPTIONS.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => { buttons.current[index] = node; }}
              type="button"
              role="radio"
              aria-checked={value === option.value}
              tabIndex={value === option.value ? 0 : -1}
              className={`ui-segmented__option${value === option.value ? " ui-segmented__option--selected" : ""}`}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    />
  );
}
