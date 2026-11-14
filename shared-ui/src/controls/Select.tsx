"use client";

import { SectionedPicker, type PickerOption } from "./SectionedPicker";

/** A dropdown for one list. It shares the picker's look and keyboard behavior, so every dropdown in Draft matches. */
export function Select<T extends string>({ label, value, options, onChange, disabled, searchable }: {
  /** The accessible name. The visible label is the caller's. */
  label: string;
  value: T;
  options: ReadonlyArray<PickerOption & { value: T }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  searchable?: boolean;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <SectionedPicker
      label={label}
      variant="field"
      disabled={disabled}
      sections={[{ id: "options", title: label, value, options: [...options], searchable, onChange: (next) => onChange(next as T) }]}
    >
      {selected?.label ?? value}
    </SectionedPicker>
  );
}
