import { normalizeInputText } from "draft-core/live-sessions";

export function cleanInputText(text: string): string {
  return normalizeInputText(text).trim();
}

/** Claude may fold line breaks or trailing spaces, so matching ignores whitespace differences. */
export function sameText(a: string, b: string): boolean {
  const normal = (value: string) => value.replace(/\s+/g, " ").trim();
  return normal(a) === normal(b);
}
