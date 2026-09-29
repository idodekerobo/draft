// Analytics events emitted by shared screens or by both apps. Props hold coded
// values only: never message or file content, paths, names, emails or typed text.

export const PLATFORM_PROPERTY = "platform";
export type AnalyticsPlatform = "web" | "desktop" | "landing";

export type FlowStep = "confirm_join" | "what_draft_knows" | "connect_tools" | "give_source" | "reading" | "first_context";

export type SharedAnalyticsEvent =
  | { event: "invite_viewed";              props: Record<string, never> }
  | { event: "account_created";            props: { method: "email" | "google" } }
  | { event: "invite_joined";              props: Record<string, never> }
  | { event: "onboarding_step_viewed";     props: { step: FlowStep } }
  | { event: "onboarding_completed";       props: { step: FlowStep } }
  | { event: "onboarding_skipped";         props: { step: FlowStep } }
  | { event: "analytics_consent_granted";  props: Record<string, never> }
  | { event: "first_tool_connected";       props: { source: string } }
  | { event: "integration_connected";      props: { source: string } }
  | { event: "integration_disconnected";   props: { source: string } }
  | { event: "integration_channels_updated"; props: { source: string } };

export type SharedEventName = SharedAnalyticsEvent["event"];

export type TrackFn = <E extends SharedEventName>(
  event: E,
  props: Extract<SharedAnalyticsEvent, { event: E }>["props"],
) => void;
