import posthog from "posthog-js";

const STORAGE_KEY = "draft_attribution";
const VISITOR_KEY = "draft_visitor_id";
const CAMPAIGN_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ttclid", "fbclid"] as const;

type Touch = Partial<Record<(typeof CAMPAIGN_PARAMS)[number] | "landing_url" | "referrer", string>>;
export interface Attribution {
  first?: Touch;
  last?: Touch;
}

function read(): Attribution {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Attribution;
  } catch {
    return {};
  }
}

function write(value: Attribution) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be blocked; attribution is then best-effort.
  }
}

function currentTouch(): { touch: Touch; hasCampaign: boolean } {
  const params = new URLSearchParams(window.location.search);
  const touch: Touch = {
    landing_url: window.location.href,
    ...(document.referrer ? { referrer: document.referrer } : {}),
  };
  let hasCampaign = false;
  for (const key of CAMPAIGN_PARAMS) {
    const value = params.get(key);
    if (value) {
      touch[key] = value;
      hasCampaign = true;
    }
  }
  return { touch, hasCampaign };
}

// First touch is written once. Last touch only changes when a visit carries campaign params.
export function captureAttribution() {
  const stored = read();
  const { touch, hasCampaign } = currentTouch();
  const next: Attribution = { ...stored };
  if (!stored.first || (!stored.first.utm_source && hasCampaign)) next.first = touch;
  if (!stored.last || hasCampaign) next.last = touch;
  write(next);
}

export function getAttribution(): Attribution {
  return read();
}

export function getVisitorId(): string {
  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) return posthog.get_distinct_id();
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

export const CAL_BASE = "https://cal.com/idode/learn-about-draft";

// Carries the visitor's channel into the booking; falls back to a site-origin tag.
export function buildCalLink(): string {
  const last = read().last ?? {};
  const params = new URLSearchParams({
    utm_source: last.utm_source ?? "draftai_site",
    utm_medium: last.utm_medium ?? "website",
    utm_campaign: last.utm_campaign ?? "book_a_call",
  });
  if (last.utm_content) params.set("utm_content", last.utm_content);
  return `${CAL_BASE}?${params.toString()}`;
}
