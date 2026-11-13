import { renderMarkdown } from "../context/markdown";

const MAX_ENTRIES = 500;
const cache = new Map<string, string>();

/** The HTML of a message. A stream re-renders often while text arrives, and stored messages do not change, so each is parsed once. */
export function cachedMarkdown(text: string, render: (text: string) => string = renderMarkdown): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = render(text);
  cache.set(text, html);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return html;
}
