"use client";

import { useEffect, useId, useState } from "react";
import { AppearanceRow, DataBoundary, PrivacyRows, SettingsRow, THEME_STORAGE_KEY, Toggle, applyTheme, isThemePreference, queryKeys, useOptimisticMutation, useSuspenseQuery, type ThemePreference } from "draft-shared-ui";
import { apiFetch } from "@/lib/api";
import { scheduleQueryOptions, type Schedule } from "@/lib/queries";
import { createClient } from "@/lib/supabase/client";
import { useWorkspace } from "@/lib/workspace";

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

function SynthesisRow({ onError }: { onError: (message: string) => void }) {
  const { workspaceId } = useWorkspace();
  const synthesisId = useId();
  const { data: schedule } = useSuspenseQuery(scheduleQueryOptions(workspaceId, apiFetch));
  const toggle = useOptimisticMutation<Schedule, boolean>({
    queryKey: queryKeys.synthesisSchedule(workspaceId),
    mutationFn: (enabled) => apiFetch<Schedule>(`/workspaces/${workspaceId}/synthesis-schedule`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
    apply: (_current, enabled) => ({ enabled }),
    onError: () => onError("Could not save. Try again."),
  });
  return (
    <>
      <h2 className="ui-group-label">Synthesis</h2>
      <ul className="ui-rows">
        <li>
          <SettingsRow
            label="Update team context"
            labelId={synthesisId}
            helper="Draft reads new sources hourly during the day and every few hours overnight (UTC)."
            control={<Toggle checked={schedule.enabled} onChange={(next) => toggle.mutate(next)} labelledBy={synthesisId} />}
          />
        </li>
      </ul>
    </>
  );
}

export default function SettingsPage() {
  const { identity, updatePrivacy } = useWorkspace();
  const [theme, setTheme] = useThemePreference();
  const [error, setError] = useState<string | null>(null);

  async function savePrivacy(patch: { analytics_consent: boolean }) {
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
      <p className="ui-page__intro">Make Draft feel right for you.</p>
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

      {/* The schedule row is optional: hide it while loading or if it fails. */}
      <DataBoundary fallback={null} errorFallback={null}>
        <SynthesisRow onError={setError} />
      </DataBoundary>

      <h2 className="ui-group-label">Privacy</h2>
      <ul className="ui-rows">
        <PrivacyRows
          analyticsConsent={identity.analytics_consent === true}
          onAnalyticsChange={(next) => void savePrivacy({ analytics_consent: next })}
        />
      </ul>

      <h2 className="ui-group-label">Appearance</h2>
      <ul className="ui-rows">
        <li><AppearanceRow value={theme} onChange={setTheme} /></li>
      </ul>
    </div>
  );
}

