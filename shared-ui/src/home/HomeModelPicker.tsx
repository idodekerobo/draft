"use client";

import { useState } from "react";
import { SectionedPicker } from "../controls/SectionedPicker";

export interface HomeModel {
  id: string;
  name: string;
}

/**
 * Picks the model Draft answers with, with the same picker as a session's model. A change applies from the next request,
 * and a model the account cannot use says why when it is tried, in the thread, in the provider's own words.
 */
export function HomeModelPicker({ models, value, onSelect }: { models: readonly HomeModel[]; value: string | null; onSelect: (id: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (models.length === 0) return null;
  const current = models.find((model) => model.id === value);

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
    <>
      <SectionedPicker
        label="Model"
        align="start"
        direction="up"
        disabled={saving}
        sections={[{ id: "model", title: "Model", options: models.map((model) => ({ value: model.id, label: model.name })), value: current?.id ?? "", onChange: (id) => void choose(id) }]}
      >
        {current?.name ?? value ?? "Choose a model"}
      </SectionedPicker>
      {error && <span className="ui-error" role="alert">{error}</span>}
    </>
  );
}
