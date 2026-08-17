export type SlackConfigEnvironment = Readonly<Record<string, string | undefined>>;

// DRAFT_API_BASE_URL isn't needed by Socket Mode itself -- it's here for a
// future webhook-URL display/health-check surface. It's also the backend's
// own public base URL, shared with backend/src/config.ts and
// backend/src/sandbox/config.ts.

export interface SlackListenerConfig {
  draftApiBaseUrl: string;
}

function required(env: SlackConfigEnvironment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

export function validateSlackListenerConfig(
  config: SlackListenerConfig,
): SlackListenerConfig {
  for (const [name, value] of Object.entries(config)) {
    if (value.trim().length === 0) {
      throw new Error(`${name} must not be empty`);
    }
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(config.draftApiBaseUrl);
  } catch {
    throw new Error("DRAFT_API_BASE_URL must be a valid HTTPS URL");
  }
  if (baseUrl.protocol !== "https:") {
    throw new Error("DRAFT_API_BASE_URL must be a valid HTTPS URL");
  }

  return { ...config };
}

export function loadSlackListenerConfig(
  env: SlackConfigEnvironment = process.env,
): SlackListenerConfig {
  return validateSlackListenerConfig({
    draftApiBaseUrl: required(env, "DRAFT_API_BASE_URL"),
  });
}

export interface SlackBatchLimits {
  /** Cut a batch once its oldest and newest message are this far apart. */
  maxSpanMs: number;
  /** Cut a batch once it holds this many messages. */
  maxMessageCount: number;
  /** Cut a batch once its rendered content_markdown reaches this many bytes. */
  maxContentBytes: number;
}

export const DEFAULT_SLACK_BATCH_LIMITS: Readonly<SlackBatchLimits> = {
  maxSpanMs: 24 * 60 * 60 * 1000,
  maxMessageCount: 300,
  maxContentBytes: 150_000,
};

function optionalPositiveInt(
  env: SlackConfigEnvironment,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

/** Load Slack batch-cut thresholds, falling back to DEFAULT_SLACK_BATCH_LIMITS per-field. */
export function loadSlackBatchLimits(
  env: SlackConfigEnvironment = process.env,
): SlackBatchLimits {
  return {
    maxSpanMs:
      optionalPositiveInt(env, "SLACK_BATCH_MAX_SPAN_HOURS", DEFAULT_SLACK_BATCH_LIMITS.maxSpanMs / 3_600_000) *
      3_600_000,
    maxMessageCount: optionalPositiveInt(
      env,
      "SLACK_BATCH_MAX_MESSAGES",
      DEFAULT_SLACK_BATCH_LIMITS.maxMessageCount,
    ),
    maxContentBytes: optionalPositiveInt(
      env,
      "SLACK_BATCH_MAX_CONTENT_BYTES",
      DEFAULT_SLACK_BATCH_LIMITS.maxContentBytes,
    ),
  };
}
