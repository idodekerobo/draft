export const MAX_INPUT_CHARS = 10_000;

// Control characters other than newline and tab. Pasting one into the pane could end the
// bracketed paste early and turn the rest of the text into key presses.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function cleanInputText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "").trim();
}

function cleanAuthorName(name: string): string {
  return name.replace(/[\][\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "A teammate";
}

/** What Claude sees: the message with its author in front. */
export function deliveredText(authorName: string, text: string): string {
  return `[${cleanAuthorName(authorName)} via Draft] ${text}`;
}

/** Claude may fold line breaks or trailing spaces, so matching ignores whitespace differences. */
export function sameText(a: string, b: string): boolean {
  const normal = (value: string) => value.replace(/\s+/g, " ").trim();
  return normal(a) === normal(b);
}
