/** The stored host name of a session in Draft's sandboxes. The app shows the product name instead. */
const STORED_CLOUD_HOST = "Draft cloud";

/** A session's host name as the app shows it. */
export function displayHostName(hostName: string | null | undefined): string | null {
  if (!hostName) return null;
  return hostName === STORED_CLOUD_HOST ? "Draft Cloud" : hostName;
}
