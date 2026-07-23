// ProfileStep.tsx — step 2: create / pick workspace profile

import type { ProfileDetail } from "../../../../rpc/schema";

interface ProfileStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  profileList: ProfileDetail[];
  profilesLoaded: boolean;
  newProfileName: string;
  setNewProfileName: (name: string) => void;
  profileError: string | null;
  settingProfile: boolean;
  handleSelectProfile: (name: string) => void;
  handleCreateProfile: () => void;
  /**
   * Join-team path only: render the create-new-profile form, no
   * existing-profile picker. A freshly created profile has an empty
   * workspace, so the dirty-baseline/unpublished-changes guards in
   * stageTeamContent can never fire during a join — this makes "existing
   * profile has conflicting local state" structurally impossible rather than
   * something to detect and explain.
   */
  restrictToNewProfile?: boolean;
}

export function ProfileStep({
  stepNum,
  totalSteps,
  onBack,
  profileList,
  profilesLoaded,
  newProfileName,
  setNewProfileName,
  profileError,
  settingProfile,
  handleSelectProfile,
  handleCreateProfile,
  restrictToNewProfile,
}: ProfileStepProps) {
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Name your workspace</h1>

      <div className="onboarding__education">
        <div className="onboarding__education-text">
          <strong>What's a workspace?</strong>
          <span>
            A workspace stores the product context Draft captures for one
            project — your team, goals, and decisions. Claude Code reads it
            at the start of every session. One workspace per product.
          </span>
        </div>
      </div>

      {!restrictToNewProfile && profilesLoaded && profileList.length > 0 && (
        <>
          <p className="onboarding__desc" style={{ marginBottom: 10 }}>
            You have existing workspaces — pick one or create a new one.
          </p>
          <div className="onboarding__tool-list">
            {profileList.map((p) => (
              <button
                key={p.name}
                className="onboarding__tool-row"
                onClick={() => !settingProfile && handleSelectProfile(p.name)}
                disabled={settingProfile}
              >
                <span className="onboarding__tool-check" />
                <span className="onboarding__tool-text">
                  <span className="onboarding__tool-name">{p.name}</span>
                  <span className="onboarding__tool-desc">
                    {p.hasContext ? "Context ready" : "Empty — populate with /draft-setup"}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="setup-incomplete__divider"><span>or create new</span></div>
        </>
      )}

      <div className="setup-incomplete__create-form">
        <input
          className="setup-incomplete__create-input"
          type="text"
          placeholder="e.g. acme, my-startup"
          value={newProfileName}
          onChange={(e) => setNewProfileName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreateProfile()}
          autoFocus
        />
        <button
          className="empty-state__cta onboarding__cta"
          onClick={handleCreateProfile}
          disabled={!newProfileName.trim() || settingProfile}
        >
          {settingProfile ? "Creating…" : "Create"}
        </button>
      </div>

      {profileError && <p className="onboarding__error">{profileError}</p>}
    </div>
  );
}
