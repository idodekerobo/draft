export const MAX_MARKDOWN_CHARS = 200_000;

export interface RenderedContent {
  markdown: string;
  structured: unknown;
  truncated: boolean;
}

const URL_KEYS = new Set(["contentUri", "sourceUri", "thumbnailUri", "thumbnailUrl", "imageUri"]);

// Image and thumbnail URLs in API responses are signed and short-lived.
export function stripUrlFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUrlFields) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (!URL_KEYS.has(key)) out[key] = stripUrlFields(child);
    }
    return out as T;
  }
  return value;
}

export function capMarkdown(markdown: string, limit = MAX_MARKDOWN_CHARS): { markdown: string; truncated: boolean } {
  if (markdown.length <= limit) return { markdown, truncated: false };
  return { markdown: `${markdown.slice(0, limit)}\n\n[Truncated: content exceeds ${limit} characters.]`, truncated: true };
}

export function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function tableToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length), 1);
  const padded = rows.map((row) => Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? "")));
  const [header, ...body] = padded;
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}
