/** GET /whoami response. */
export interface Identity {
  id: string;
  email: string;
  organization_id: string | null;
  primary_team_id: string | null;
  onboarding_completed_at: string | null;
  analytics_consent: boolean | null;
  analytics_consent_at: string | null;
  workspace_id: string | null;
}
