import { useEffect, useRef, useState } from "react";
import { LabPicker, type LabOption } from "./LabPicker";

export interface ModelProviderView {
  provider: string;
  canEdit: boolean;
  providers: readonly LabOption[];
}

/** Loads the workspace's AI lab and saves a change. Each app supplies how it reaches the backend. */
export function ModelProviderPicker({ load, save }: {
  load: () => Promise<ModelProviderView>;
  save: (provider: string) => Promise<void>;
}) {
  const [view, setView] = useState<ModelProviderView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // It loads once. A caller that passes a new function each render must not make it load again.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    loadRef.current().then((value) => !cancelled && setView(value)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Without the answer there is nothing true to show, and the step works without it.
  if (!view) return null;

  async function choose(provider: string) {
    if (!view) return;
    const previous = view.provider;
    setError(null);
    setSaving(true);
    setView({ ...view, provider });
    try {
      await save(provider);
    } catch {
      setView((current) => (current ? { ...current, provider: previous } : current));
      setError("Could not save your choice. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return <LabPicker labs={view.providers} value={view.provider} canEdit={view.canEdit} saving={saving} error={error} onChange={(id) => void choose(id)} />;
}
