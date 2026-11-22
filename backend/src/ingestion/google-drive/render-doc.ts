import { capMarkdown, stripUrlFields, tableToMarkdown, type RenderedContent } from "./render-common";

interface TextRun {
  content?: string;
  textStyle?: { link?: { url?: string } };
}
interface ParagraphElement {
  textRun?: TextRun;
}
interface Paragraph {
  elements?: ParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
}
interface StructuralElement {
  paragraph?: Paragraph;
  table?: { tableRows?: { tableCells?: { content?: StructuralElement[] }[] }[] };
}
interface DocTab {
  tabProperties?: { title?: string };
  documentTab?: {
    body?: { content?: StructuralElement[] };
    lists?: Record<string, { listProperties?: { nestingLevels?: { glyphType?: string }[] } }>;
  };
  childTabs?: DocTab[];
}
export interface GoogleDocument {
  title?: string;
  tabs?: DocTab[];
  body?: { content?: StructuralElement[] };
}

const HEADINGS: Record<string, string> = {
  TITLE: "#",
  HEADING_1: "#",
  HEADING_2: "##",
  HEADING_3: "###",
  HEADING_4: "####",
  HEADING_5: "#####",
  HEADING_6: "######",
};

function paragraphText(paragraph: Paragraph): string {
  return (paragraph.elements ?? [])
    .map((element) => {
      const run = element.textRun;
      if (!run?.content) return "";
      const url = run.textStyle?.link?.url;
      const text = run.content.replace(/\n$/, "");
      return url && text.trim() ? `[${text}](${url})` : text;
    })
    .join("");
}

function isOrdered(lists: NonNullable<DocTab["documentTab"]>["lists"], paragraph: Paragraph): boolean {
  const bullet = paragraph.bullet;
  if (!bullet?.listId) return false;
  const glyph = lists?.[bullet.listId]?.listProperties?.nestingLevels?.[bullet.nestingLevel ?? 0]?.glyphType;
  return Boolean(glyph && /DECIMAL|ALPHA|ROMAN/.test(glyph));
}

function renderContent(content: StructuralElement[], lists: NonNullable<DocTab["documentTab"]>["lists"]): string[] {
  const blocks: string[] = [];
  for (const element of content) {
    if (element.paragraph) {
      const paragraph = element.paragraph;
      const text = paragraphText(paragraph);
      if (!text.trim()) continue;
      const heading = HEADINGS[paragraph.paragraphStyle?.namedStyleType ?? ""];
      if (heading) blocks.push(`${heading} ${text}`);
      else if (paragraph.bullet) {
        const indent = "  ".repeat(paragraph.bullet.nestingLevel ?? 0);
        blocks.push(`${indent}${isOrdered(lists, paragraph) ? "1." : "-"} ${text}`);
      } else blocks.push(text);
    } else if (element.table) {
      const rows = (element.table.tableRows ?? []).map((row) =>
        (row.tableCells ?? []).map((cell) => renderContent(cell.content ?? [], lists).join(" ")),
      );
      const table = tableToMarkdown(rows);
      if (table) blocks.push(table);
    }
  }
  return blocks;
}

function renderTab(tab: DocTab, depth: number): string[] {
  const blocks: string[] = [];
  const title = tab.tabProperties?.title;
  if (title) blocks.push(`${"#".repeat(Math.min(depth + 1, 6))} Tab: ${title}`);
  blocks.push(...renderContent(tab.documentTab?.body?.content ?? [], tab.documentTab?.lists));
  for (const child of tab.childTabs ?? []) blocks.push(...renderTab(child, depth + 1));
  return blocks;
}

export function renderDocument(document: GoogleDocument): RenderedContent {
  const tabs = document.tabs ?? [];
  const blocks =
    tabs.length > 1
      ? tabs.flatMap((tab) => renderTab(tab, 1))
      : tabs.length === 1
        ? renderTab({ ...tabs[0], tabProperties: undefined }, 1)
        : renderContent(document.body?.content ?? [], undefined);
  const body = blocks.join("\n\n");
  const markdown = document.title ? `# ${document.title}\n\n${body}` : body;
  const capped = capMarkdown(markdown);
  return { markdown: capped.markdown, structured: stripUrlFields(document), truncated: capped.truncated };
}
