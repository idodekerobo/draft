// SetupIncompleteView.tsx — workspace selector shown when active profile has no context
//
// Shown when appState.userState === "setup-incomplete":
// A profile is active but its workspace has no context files yet.
// Options: run /draft-setup in the current workspace, switch to a ready workspace,
// create a new workspace, or bypass to the app.

import { useState, useEffect } from "react";
import { rpc } from "../../rpc";
import type { ProfileDetail } from "../../../rpc/schema";

const SETUP_COMMAND = "/draft-setup";

interface SetupIncompleteViewProps {
  onComplete: () => void;
}

export function SetupIncompleteView({ onComplete }: SetupIncompleteViewProps) {
  const [profiles, setProfiles]   = useState<ProfileDetail[]>([]);
  const [active, setActive]       = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName]     = useState("");
  const [creating, setCreating]   = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [copied, setCopied]       = useState(false);

  useEffect(() => {
    rpc.request.getProfiles().then((pl) => {
      setProfiles(pl.details);
      setActive(pl.active);
    }).catch(() => {});
  }, []);

  async function handleSwitch(name: string) {
    if (switching) return;
    setSwitching(name);
    setError(null);
    try {
      const result = await rpc.request.switchProfile({ profile: name });
      if (result.ok) {
        onComplete();
      } else {
        setError(result.error ?? "Switch failed.");
        setSwitching(null);
      }
    } catch {
      setError("Switch failed.");
      setSwitching(null);
    }
  }

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await rpc.request.createProfile({ name: trimmed });
      if (result.ok) {
        onComplete();
      } else {
        setError(result.error ?? "Could not create workspace.");
        setCreating(false);
      }
    } catch {
      setError("Could not create workspace.");
      setCreating(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(SETUP_COMMAND).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const otherProfiles = profiles.filter((p) => p.name !== active);

  return (
    <div className="setup-incomplete">
      <div className="setup-incomplete__body">
        <div className="setup-incomplete__icon">◎</div>
        <p className="setup-incomplete__title">Almost ready</p>
        <p className="setup-incomplete__desc">
          Workspace <code className="onboarding__code">{active || "…"}</code> has
          no context yet. Open Claude Code and run{" "}
          <code className="onboarding__code">{SETUP_COMMAND}</code> to populate it.
        </p>
        <button className="empty-state__cta setup-incomplete__copy" onClick={handleCopy}>
          {copied ? "Copied" : "Copy command"}
        </button>

        {otherProfiles.length > 0 && (
          <>
            <div className="setup-incomplete__divider"><span>or switch workspace</span></div>
            <div className="setup-incomplete__profile-list">
              {otherProfiles.map((p) => (
                <button
                  key={p.name}
                  className="setup-incomplete__profile-row"
                  onClick={() => handleSwitch(p.name)}
                  disabled={!!switching}
                >
                  <span className="setup-incomplete__profile-name">{p.name}</span>
                  <span className={`setup-incomplete__profile-badge${p.hasContext ? " setup-incomplete__profile-badge--ready" : ""}`}>
                    {switching === p.name ? "switching…" : p.hasContext ? "ready" : "needs setup"}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {!showCreate ? (
          <button className="setup-incomplete__create-btn" onClick={() => setShowCreate(true)}>
            + New workspace
          </button>
        ) : (
          <div className="setup-incomplete__create-form">
            <input
              className="setup-incomplete__create-input"
              type="text"
              placeholder="workspace-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
            <button
              className="empty-state__cta"
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        )}

        {error && <p className="setup-incomplete__error">{error}</p>}

        <button className="setup-incomplete__bypass" onClick={onComplete}>
          Continue to app anyway →
        </button>
      </div>
    </div>
  );
}
