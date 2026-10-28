const PARAM = "m";

export function sessionUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/sessions/${sessionId}`;
}

export function messageUrl(baseUrl: string, sessionId: string, seq: number): string {
  return `${sessionUrl(baseUrl, sessionId)}?${PARAM}=${seq}`;
}

/** The seq a link points at, or null when the value is not a message number. */
export function parseMessageParam(value: string | null | undefined): number | null {
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

export const MESSAGE_PARAM = PARAM;

export const messageDomId = (seq: number) => `${PARAM}-${seq}`;

/** For example "Oct 28, 5:27 pm", in the viewer's locale and time zone. */
export function formatMessageTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })
    .format(date)
    .replace(/[\u202f\u00a0]/g, " ")
    .replace(/[AP]M$/, (period) => period.toLowerCase());
  return `${day}, ${time}`;
}
