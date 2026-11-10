import type { FailureCategory } from "./types";

/** Sorts a piece of a harness's error output into a category, keeping the first specific one it saw. */
export function classifyFailureChunk(
  chunk: string,
  current: FailureCategory = "none",
): FailureCategory {
  if (current !== "none" && current !== "other") return current;
  const text = chunk.toLowerCase();
  if (/oauth|unauth|invalid api key|authenticat/.test(text)) return "auth";
  if (/rate.?limit|too many requests|\b429\b/.test(text)) return "rate_limit";
  if (/permission|not allowed|access denied|\b403\b/.test(text)) return "permission";
  if (/network|econn|enotfound|dns|socket|timed? ?out/.test(text)) return "network";
  return text.trim() ? "other" : current;
}
