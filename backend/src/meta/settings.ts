export interface MetaSettings {
  pixelId: string;
  accessToken: string;
  testEventCode?: string;
}

// Returns null when sending is off. Outside production a test event code is required,
// so a staging run cannot send real events to the live pixel.
export function readMetaSettings(env: Record<string, string | undefined> = process.env): MetaSettings | null {
  const pixelId = env.META_PIXEL_ID?.trim();
  const accessToken = env.META_CAPI_ACCESS_TOKEN?.trim();
  if (!pixelId || !accessToken) return null;
  const testEventCode = env.META_CAPI_TEST_EVENT_CODE?.trim() || undefined;
  if (env.META_CAPI_LIVE !== "true" && !testEventCode) return null;
  return { pixelId, accessToken, ...(testEventCode ? { testEventCode } : {}) };
}
