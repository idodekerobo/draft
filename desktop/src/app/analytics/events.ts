// desktop/src/app/analytics/events.ts — typed analytics event union
//
// To add a new event: add a member to AnalyticsEvent, then call track() at the callsite.
// The compiler will reject any event name or props shape not declared here.
//
// Props must never include: message content, file content, file paths, profile names,
// workspace names, or user-entered text. Use coded values only (tool names, view names,
// error codes).

export type View = "context" | "proposals" | "settings";
export type OnboardingStep = "welcome" | "tool-select" | "profile" | "complete";

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
  | { event: "tool_installed";             props: { tool: string } }
  | { event: "install_failed";             props: { tool: string; step_label: string } }
  | { event: "context_section_toggled";    props: { section: string; enabled: boolean } }
  | { event: "context_doc_viewed";         props: { kind: "dim" | "log" | "standalone" | "group-child"; group: string } }
  | { event: "context_doc_expanded";       props: { group: string } }
  | { event: "analytics_consent_granted";  props: Record<string, never> }
  | { event: "replay_consent_granted";     props: Record<string, never> };
