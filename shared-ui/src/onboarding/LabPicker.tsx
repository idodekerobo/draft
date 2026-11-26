export interface LabOption {
  id: string;
  label: string;
  enabled: boolean;
}

/** Picks the AI lab behind Draft's own agent. Only an admin can change it; everyone else sees the current choice. */
export function LabPicker({ labs, value, canEdit, saving = false, error = null, onChange }: {
  labs: readonly LabOption[];
  value: string;
  canEdit: boolean;
  saving?: boolean;
  error?: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <fieldset className="ui-lab-picker" disabled={!canEdit || saving}>
      <legend className="ui-group-label">Which AI should Draft use?</legend>
      <div className="ui-lab-picker__options">
        {labs.map((lab) => (
          <label key={lab.id} className="ui-lab-picker__option" data-disabled={!lab.enabled || undefined}>
            <input
              type="radio"
              name="lab"
              value={lab.id}
              checked={value === lab.id}
              disabled={!lab.enabled}
              onChange={() => onChange(lab.id)}
            />
            <span className="ui-lab-picker__name">{lab.label}</span>
            {!lab.enabled && <span className="ui-lab-picker__note">Coming later</span>}
          </label>
        ))}
      </div>
      {!canEdit && <p className="ui-lab-picker__help">An admin chooses this for your workspace.</p>}
      {error && <p className="ui-error" role="alert">{error}</p>}
    </fieldset>
  );
}
