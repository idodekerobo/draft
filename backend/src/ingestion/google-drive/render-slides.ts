import { capMarkdown, stripUrlFields, tableToMarkdown, type RenderedContent } from "./render-common";

interface TextElement {
  textRun?: { content?: string };
}
interface TextBlock {
  textElements?: TextElement[];
}
interface PageElement {
  objectId?: string;
  shape?: { text?: TextBlock; placeholder?: { type?: string } };
  table?: { tableRows?: { tableCells?: { text?: TextBlock }[] }[] };
}
interface Slide {
  pageElements?: PageElement[];
  slideProperties?: {
    notesPage?: {
      pageElements?: PageElement[];
      notesProperties?: { speakerNotesObjectId?: string };
    };
  };
}
export interface GooglePresentation {
  title?: string;
  slides?: Slide[];
}

function blockText(block: TextBlock | undefined): string {
  return (block?.textElements ?? []).map((element) => element.textRun?.content ?? "").join("").trim();
}

function speakerNotes(slide: Slide): string {
  const notesPage = slide.slideProperties?.notesPage;
  const id = notesPage?.notesProperties?.speakerNotesObjectId;
  const element = (notesPage?.pageElements ?? []).find((candidate) => candidate.objectId === id);
  return blockText(element?.shape?.text);
}

function renderSlide(slide: Slide, index: number): string {
  const parts: string[] = [];
  let title = "";
  for (const element of slide.pageElements ?? []) {
    if (element.shape?.text) {
      const text = blockText(element.shape.text);
      if (!text) continue;
      const type = element.shape.placeholder?.type;
      if (!title && (type === "TITLE" || type === "CENTERED_TITLE")) title = text;
      else parts.push(text);
    } else if (element.table) {
      const rows = (element.table.tableRows ?? []).map((row) => (row.tableCells ?? []).map((cell) => blockText(cell.text)));
      const table = tableToMarkdown(rows);
      if (table) parts.push(table);
    }
  }
  const notes = speakerNotes(slide);
  const lines = [`## Slide ${index + 1}${title ? `: ${title}` : ""}`, ...parts];
  if (notes) lines.push(`Speaker notes: ${notes}`);
  return lines.join("\n\n");
}

export function renderPresentation(presentation: GooglePresentation): RenderedContent {
  const slides = (presentation.slides ?? []).map(renderSlide);
  const heading = presentation.title ? `# ${presentation.title}\n\n` : "";
  const capped = capMarkdown(`${heading}${slides.join("\n\n")}`);
  return { markdown: capped.markdown, structured: stripUrlFields(presentation), truncated: capped.truncated };
}
