"use client";

import { useState } from "react";

export interface HomeModel {
  id: string;
  name: string;
}

/**
 * Picks the model Draft answers with. A change applies from the next request, and a model the account cannot use says why
 * when it is tried, in the thread, in the provider's own words.
 */
export function HomeModelPicker({ models, value, onSelect }: { models: readonly HomeModel[]; value: string | null; onSelect: (id: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (models.length === 0) return null;
  const known = models.some((model) => model.id === value);

  async function choose(id: string) {
    setError(null);
    setSaving(true);
    try {
      await onSelect(id);
    } catch {
      setError("Could not change the model. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="ui-home-model">
      <label className="ui-visually-hidden" htmlFor="home-model">Model</label>
      <select id="home-model" className="ui-home-model__select" value={known ? (value ?? "") : ""} disabled={saving} onChange={(event) => void choose(event.target.value)}>
        {!known && <option value="" disabled>{value ?? "Choose a model"}</option>}
        {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
      {error && <span className="ui-error" role="alert">{error}</span>}
    </span>
  );
}
