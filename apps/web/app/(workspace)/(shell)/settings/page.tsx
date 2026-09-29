"use client";

import { useEffect, useId, useState } from "react";
import { AppearanceRow, PrivacyRows, SettingsRow, THEME_STORAGE_KEY, Toggle, applyTheme, isThemePreference, type ThemePreference } from "draft-shared-ui";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { useWorkspace } from "@/lib/workspace";

interface Schedule {
  enabled: boolean;
}

function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>("system");
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemePreference(stored)) setPreference(stored);
    } catch {}
  }, []);
  function update(next: ThemePreference) {
    setPreference(next);
    applyTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
  }
  return [preference, update];
}

export default function SettingsPage() {
  const { identity, workspaceId, updatePrivacy } = useWorkspace();
  const [theme, setTheme] = useThemePreference();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const synthesisId = useId();

  useEffect(() => {
    apiFetch<Schedule>(`/workspaces/${workspaceId}/synthesis-schedule`).then(setSchedule).catch(() => setSchedule(null));
  }, [workspaceId]);

  async function toggleSynthesis(enabled: boolean) {
    const previous = schedule;
    setSchedule((current) => current && { ...current, enabled });
    try {
      setSchedule(await apiFetch<Schedule>(`/workspaces/${workspaceId}/synthesis-schedule`, { method: "PATCH", body: JSON.stringify({ enabled }) }));
    } catch {
      setSchedule(previous);
      setError("Could not save. Try again.");
    }
  }

  async function savePrivacy(patch: { analytics_consent?: boolean; session_replay_enabled?: boolean }) {
    setError(null);
    try {
      await updatePrivacy(patch);
    } catch {
      setError("Could not save your privacy choice. Try again.");
    }
  }

  async function signOut() {
    await createClient().auth.signOut();
    location.assign("/login");
  }

  return (
    <div className="ui-page">
      <h1 className="ui-page__title">Settings</h1>
      {error && <p className="ui-error" role="alert">{error}</p>}

      <h2 className="ui-group-label">Account</h2>
      <ul className="ui-rows">
        <li>
          <SettingsRow
            label="Draft Cloud"
            helper={`Signed in as ${identity.email}`}
            control={<button type="button" className="ui-btn" onClick={() => void signOut()}>Sign out</button>}
          />
        </li>
      </ul>

      {schedule && (
        <>
          <h2 className="ui-group-label">Synthesis</h2>
          <ul className="ui-rows">
            <li>
              <SettingsRow
                label="Update team context"
                labelId={synthesisId}
                helper="Draft reads new sources hourly during the day and every few hours overnight (UTC)."
                control={<Toggle checked={schedule.enabled} onChange={(next) => void toggleSynthesis(next)} labelledBy={synthesisId} />}
              />
            </li>
          </ul>
        </>
      )}

      <h2 className="ui-group-label">Privacy</h2>
      <ul className="ui-rows">
        <PrivacyRows
          analyticsConsent={identity.analytics_consent === true}
          sessionReplay={identity.session_replay_enabled}
          onAnalyticsChange={(next) => void savePrivacy({ analytics_consent: next })}
          onReplayChange={(next) => void savePrivacy({ session_replay_enabled: next })}
        />
      </ul>

      <h2 className="ui-group-label">Appearance</h2>
      <ul className="ui-rows">
        <li><AppearanceRow value={theme} onChange={setTheme} /></li>
      </ul>
    </div>
  );
}

