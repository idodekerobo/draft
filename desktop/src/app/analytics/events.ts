// desktop/src/app/analytics/events.ts — typed analytics event union
//
// To add a new event: add a member to AnalyticsEvent, then call track() at the callsite.
// The compiler will reject any event name or props shape not declared here.
//
// Props must never include: message content, file content, file paths, profile names,
// workspace names, or user-entered text. Use coded values only (tool names, view names,
// error codes).

import type { View, OnboardingStep } from "../types";

export type AnalyticsEvent =
  | { event: "app_launched";               props: { user_state: string } }
  | { event: "onboarding_step_viewed";     props: { step: OnboardingStep } }
  | { event: "onboarding_completed";       props: { tools_selected: string[] } }
  | { event: "onboarding_abandoned";       props: { last_step: OnboardingStep } }
  | { event: "view_navigated";             props: { view: View } }
  | { event: "proposal_actioned";          props: { action: "accepted" | "rejected"; source: string } }
  | { event: "daemon_start_attempted";     props: Record<string, never> }
  | { event: "daemon_start_succeeded";     props: { duration_ms: number } }
  | { event: "daemon_start_failed";        props: { error_code: string } }
  | { event: "integration_connected";      props: { source: string } }
  | { event: "integration_disconnected";   props: { source: string } }
  | { event: "integration_channels_updated"; props: { source: string } }
  | { event: "tool_installed";             props: { tool: string } }
  | { event: "install_failed";             props: { tool: string; step_label: string } }
  | { event: "context_section_toggled";    props: { section: string; enabled: boolean } }
  | { event: "context_doc_viewed";         props: { kind: "dim" | "log" | "standalone" | "group-child"; group: string } }
  | { event: "context_doc_expanded";       props: { group: string } }
  | { event: "context_dimension_added";    props: Record<string, never> }
  | { event: "analytics_consent_granted";  props: Record<string, never> }
  | { event: "profile_actioned";           props: { action: "created" | "selected" } }
  | { event: "install_skipped";            props: { tools: string[] } }
  | { event: "onboarding_path_chosen";      props: { path: "join" | "solo" } }
  | { event: "github_join_started";        props: Record<string, never> }
  | { event: "github_join_code_displayed"; props: Record<string, never> }
  | { event: "github_join_succeeded";      props: Record<string, never> }
  | { event: "github_join_failed";         props: { error_code: "no_access" | "expired" | "denied" | "network" | "rate_limited" | "device_flow_disabled" | "unknown" } }
  | { event: "github_join_resumed";        props: Record<string, never> }
  | { event: "team_resync_failed";         props: { error_code: "token_revoked" | "no_access" | "network" | "rate_limited"; surface: "session_start" | "desktop_pull" } };
