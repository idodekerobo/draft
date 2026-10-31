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

function readCookie(name: string): string | undefined {
  const match = document.cookie.split("; ").find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

// Meta's browser ids. Without an _fbc cookie, Meta's documented format is built from the click id.
function getMetaBrowserIds(stored: Attribution): { fbp?: string; fbc?: string } {
  const fbclid = stored.last?.fbclid ?? stored.first?.fbclid;
  const fbc = readCookie("_fbc") ?? (fbclid ? `fb.1.${Date.now()}.${fbclid}` : undefined);
  return { fbp: readCookie("_fbp"), fbc };
}

export function hasGlobalPrivacyControl(): boolean {
  return Boolean((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl);
}

// What the waitlist signup stores: the touches plus the ids the backend needs to report to Meta.
export function getSubmitAttribution(): Record<string, Record<string, string>> {
  const stored = read();
  const { fbp, fbc } = getMetaBrowserIds(stored);
  const extras: Record<string, string> = {
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    ...(hasGlobalPrivacyControl() ? { gpc: "1" } : {}),
  };
  const result: Record<string, Record<string, string>> = {};
  if (stored.first) result.first = { ...stored.first };
  result.last = { ...stored.last, ...extras };
  return result;
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
