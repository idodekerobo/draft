import { ensureAnalyticsConfig, readDraftConfig, writeDraftConfig, type AnalyticsConfig } from "draft-core/config";
import { fetchServerJSON } from "./server/server-client";

export interface PrivacyState {
  /** Null when signed out; analytics then fall back to the local choice without identity. */
  userId: string | null;
  analyticsConsent: boolean;
  sessionReplay: boolean;
}

interface ServerPrivacy {
  analytics_consent: boolean | null;
  session_replay_enabled: boolean;
}

/** Maps the account's choice onto the local config the background process reads. */
export function mirroredAnalyticsConfig(current: AnalyticsConfig, server: ServerPrivacy): AnalyticsConfig {
  return {
    ...current,
    consent: server.analytics_consent === true ? "opted_in" : server.analytics_consent === false ? "opted_out" : "pending",
    replay_enabled: server.analytics_consent === true && server.session_replay_enabled,
  };
}

function mirror(server: ServerPrivacy): void {
  const result = readDraftConfig();
  const config = result.ok ? result.config : { version: "1", tools: {} };
  writeDraftConfig({ ...config, analytics: mirroredAnalyticsConfig(ensureAnalyticsConfig(config), server) });
}

function localState(): PrivacyState {
  const result = readDraftConfig();
  const analytics = ensureAnalyticsConfig(result.ok ? result.config : { version: "1", tools: {} });
  return { userId: null, analyticsConsent: analytics.consent === "opted_in", sessionReplay: analytics.consent === "opted_in" && analytics.replay_enabled };
}

/** Signed in: the account (/whoami) is the source of truth. Signed out: the local config. */
export async function getPrivacy(signedIn: boolean): Promise<PrivacyState> {
  if (!signedIn) return localState();
  try {
    const me = await fetchServerJSON<ServerPrivacy & { id: string }>("whoami");
    mirror(me);
    return { userId: me.id, analyticsConsent: me.analytics_consent === true, sessionReplay: me.analytics_consent === true && me.session_replay_enabled };
  } catch {
    return localState();
  }
}

export async function setPrivacy(patch: { analytics_consent?: boolean; session_replay_enabled?: boolean }): Promise<PrivacyState> {
  const next = await fetchServerJSON<ServerPrivacy>("me/privacy", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  mirror(next);
  return getPrivacy(true);
}
