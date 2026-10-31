import type { CalBooking } from "../webhooks/cal/payload";
import { calAnswersToProfile } from "./cal-profile";
import {
  sendLeadEvent,
  sendScheduleEvent,
  type Attribution,
  type EventDeps,
  type EventResult,
  type SignupEvent,
} from "./events";

const METADATA_ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ttclid", "fbclid", "fbp", "fbc", "gpc"];

export interface SignupRow {
  id: string;
  email: string;
  profile: Record<string, string> | null;
  attribution: Attribution;
}

export interface SignupStore {
  findByEmail(email: string): Promise<SignupRow | null>;
  insertIfNew(row: {
    email: string;
    source: string;
    attribution: Attribution;
    profile: Record<string, string> | null;
  }): Promise<{ row: SignupRow; inserted: boolean }>;
  updateProfile(id: string, profile: Record<string, string>): Promise<void>;
}

export interface BookingDeps {
  store: SignupStore;
  events: EventDeps;
  fallbackSourceUrl?: string;
}

export interface BookingResult {
  signupId: string;
  createdSignup: boolean;
  lead: EventResult | null;
  schedule: EventResult;
}

// Cal reports the attribution the embed passed as booking metadata.
function attributionFromMetadata(metadata: Record<string, string>): Attribution {
  const last: Record<string, string> = {};
  for (const key of METADATA_ATTRIBUTION_KEYS) {
    if (metadata[key]) last[key] = metadata[key];
  }
  return Object.keys(last).length > 0 ? { last } : null;
}

function splitName(name: string | undefined): { firstName?: string; lastName?: string } {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return {};
  return { firstName: parts[0], lastName: parts.length > 1 ? parts[parts.length - 1] : undefined };
}

// Answers already on the signup win. Booking answers only fill the gaps.
function fillMissing(existing: Record<string, string> | null, incoming: Record<string, string>) {
  const merged = { ...incoming, ...(existing ?? {}) };
  const changed = Object.keys(merged).length > Object.keys(existing ?? {}).length;
  return { merged, changed };
}

export async function handleBookingCreated(booking: CalBooking, deps: BookingDeps): Promise<BookingResult> {
  const answers = calAnswersToProfile({ ...booking.answers, name: booking.name });
  const { row, inserted } = await deps.store.insertIfNew({
    email: booking.email,
    source: "cal_direct",
    attribution: attributionFromMetadata(booking.metadata),
    profile: Object.keys(answers).length > 0 ? answers : null,
  });

  if (!inserted) {
    const { merged, changed } = fillMissing(row.profile, answers);
    if (changed) await deps.store.updateProfile(row.id, merged);
  }

  const base: SignupEvent = {
    signupId: row.id,
    email: booking.email,
    eventId: booking.uid,
    source: booking.metadata.source ?? "cal_booking",
    attribution: row.attribution,
    client: { sourceUrl: booking.metadata.source_url ?? deps.fallbackSourceUrl },
    ...splitName(booking.name),
    fbp: booking.metadata.fbp,
    fbc: booking.metadata.fbc,
    optedOut: booking.metadata.gpc === "1",
  };

  // A direct booker never went through the signup form, so this is also their first Lead.
  const [lead, schedule] = await Promise.all([
    inserted ? sendLeadEvent({ ...base, eventId: `lead-${booking.uid}` }, deps.events) : Promise.resolve(null),
    sendScheduleEvent({ ...base, eventId: booking.metadata.event_id ?? booking.uid }, deps.events),
  ]);

  return { signupId: row.id, createdSignup: inserted, lead, schedule };
}
