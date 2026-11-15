/** Accepts "K7M-4QX", "k7m4qx" or "K7M 4QX" and returns the bare 6-character code. */
export function normalizeConfirmCode(input: string): string {
  return input.replace(/[^a-z0-9]/gi, "").toUpperCase();
}
