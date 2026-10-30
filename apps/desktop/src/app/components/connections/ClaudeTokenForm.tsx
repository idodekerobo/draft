import { useState, type FormEvent } from "react";
import { rpc } from "../../rpc";

/** Saves the Claude token the workspace's routines run with. People make one with `claude setup-token`. */
export function ClaudeTokenForm({ onSaved, onCancel, autoFocus }: { onSaved: () => void; onCancel?: () => void; autoFocus?: boolean }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || saving) return;
    setSaving(true);
    setError(null);
    const result = await rpc.request.connectClaudeCode({ token }).catch(() => ({ ok: false as const, error: "Could not save the token." }));
    setSaving(false);
    if (result.ok) {
      setToken("");
      onSaved();
    } else {
      setError(result.error ?? "Could not save the token.");
    }
  }

  return (
    <form onSubmit={save} className="ui-start__setup-actions">
      <label className="ui-visually-hidden" htmlFor="claude-routine-token">Claude token</label>
      <input
        id="claude-routine-token"
        className="ui-input ph-no-capture"
        type="password"
        autoComplete="off"
        placeholder="Paste the token from claude setup-token"
        value={token}
        disabled={saving}
        autoFocus={autoFocus}
        onChange={(event) => setToken(event.target.value)}
      />
      <button type="submit" className="ui-btn ui-btn--primary" disabled={saving || !token.trim()}>{saving ? "Saving…" : "Save token"}</button>
      {onCancel && <button type="button" className="ui-btn" disabled={saving} onClick={onCancel}>Cancel</button>}
      {error && <span className="ui-error" role="alert">{error}</span>}
    </form>
  );
}
