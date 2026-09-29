// React-free context snapshot mapping, shared by the desktop main process and web.
// Import from "draft-shared-ui/context-files", never the package index.

export interface ContextFileEntry {
  relativePath: string;
  label: string;
  content: string;
  /** Verbatim YAML frontmatter block (including `---` delimiters), or "" if none. */
  frontmatterRaw: string;
  kind: "dim" | "log" | "standalone" | "group-child";
  group: string;
  groupLabel: string;
}

const CONTEXT_SKIP_ROOT = new Set(["log", "accepted", "rejected"]);
const CONTEXT_DIMENSION_ORDER = ["company", "product", "team", "priorities"];

function capitalize(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function slugToLabel(slug: string): string {
  return capitalize(slug.replace(/[-_]/g, " "));
}

export function splitFrontmatter(content: string): { frontmatterRaw: string; body: string } {
  if (!content.startsWith("---")) return { frontmatterRaw: "", body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatterRaw: "", body: content };
  const body = content.slice(end + 4).replace(/^\n/, "");
  return { frontmatterRaw: content.slice(0, content.length - body.length), body };
}

function logEntryLabel(filename: string): string {
  const base = filename.replace(/\.md$/, "");
  // Expect prefix like 20260514_ or 20260514-
  const match = base.match(/^(\d{4})(\d{2})(\d{2})[_-]/);
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  }
  return slugToLabel(base);
}

export function toContextFileEntry(relativePath: string, content: string): ContextFileEntry | null {
  const segments = relativePath.split("/");
  const [group, second, third] = segments;
  if (!group || CONTEXT_SKIP_ROOT.has(group) || !relativePath.endsWith(".md")) return null;

  const split = splitFrontmatter(content);
  if (segments.length === 1) {
    const base = relativePath.replace(/\.md$/, "");
    return {
      relativePath,
      label: slugToLabel(base),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "standalone",
      group: base,
      groupLabel: slugToLabel(base),
    };
  }

  if (segments.length === 2 && second === "index.md") {
    return {
      relativePath,
      label: slugToLabel(group),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "dim",
      group,
      groupLabel: slugToLabel(group),
    };
  }

  if (segments.length === 3 && second === "log" && third) {
    return {
      relativePath,
      label: logEntryLabel(third),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "log",
      group,
      groupLabel: slugToLabel(group),
    };
  }

  if (segments.length === 2 && second) {
    const base = second.replace(/\.md$/, "");
    return {
      relativePath,
      label: slugToLabel(base),
      content: split.body,
      frontmatterRaw: split.frontmatterRaw,
      kind: "group-child",
      group,
      groupLabel: slugToLabel(group),
    };
  }

  return null;
}

export function sortContextFileEntries(entries: ContextFileEntry[]): ContextFileEntry[] {
  return entries.sort((a, b) => {
    function sortKey(e: ContextFileEntry): [number, number, string, string] {
      const stdIdx = CONTEXT_DIMENSION_ORDER.indexOf(e.group);
      if (e.kind === "dim") {
        return [stdIdx !== -1 ? stdIdx : 100 + e.group.charCodeAt(0), 0, e.group, ""];
      }
      if (e.kind === "log") {
        return [stdIdx !== -1 ? stdIdx : 100 + e.group.charCodeAt(0), 1, e.group, e.relativePath];
      }
      if (e.kind === "standalone") return [200, 0, e.group, ""];
      return [300, 0, e.group, e.relativePath];
    }

    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      const av = ka[i];
      const bv = kb[i];
      if (av === undefined || bv === undefined) break;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
}

export function documentsToEntries(documents: Record<string, { content: string }>): ContextFileEntry[] {
  return sortContextFileEntries(
    Object.entries(documents).flatMap(([path, document]) => {
      const entry = toContextFileEntry(path, document.content);
      return entry ? [entry] : [];
    }),
  );
}

export interface FrontmatterFields {
  name?: string;
  last_updated?: string;
  source?: string;
}

export function parseFrontmatterFields(frontmatterRaw: string): FrontmatterFields {
  const match = frontmatterRaw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?$/);
  if (!match?.[1]) return {};

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value && value !== ">") fields[key] = value;
  }

  return { name: fields["name"], last_updated: fields["last_updated"], source: fields["source"] };
}

/** First prose paragraph of a markdown body, stripped of inline markup and truncated. */
export function contextExcerpt(body: string, maxLength = 240): string {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|[-*+] |\d+\. |>|```|\||---)/.test(block)) ?? "";
  const plain = paragraph.replace(/\s+/g, " ").replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, (_m, text) => text ?? "");
  return plain.length > maxLength ? `${plain.slice(0, maxLength).replace(/\s+\S*$/, "")}…` : plain;
}
