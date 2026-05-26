/**
 * PostHog event name constants for the landing page.
 *
 * Always import from here instead of writing raw strings.
 * Typos become compile errors, renames are a one-line change.
 */
export const EVENTS = {
  // Page / section visibility
  SECTION_VIEWED: 'section_viewed',

  // CTA interactions
  CTA_CLICKED: 'cta_clicked',

  // Demo flow
  DEMO_STARTED: 'demo_started',
  DEMO_TOKEN_GENERATED: 'demo_token_generated',
  DEMO_TO_ONBOARDING: 'demo_to_onboarding',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
