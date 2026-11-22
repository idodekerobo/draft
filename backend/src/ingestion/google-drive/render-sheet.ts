import { capMarkdown, stripUrlFields, tableToMarkdown, type RenderedContent } from "./render-common";

export const MAX_SHEET_ROWS = 200;
export const MAX_SHEET_COLUMNS = 26;

export interface SheetValueRange {
  range?: string;
  values?: unknown[][];
}

export interface SheetTab {
  title: string;
  range: string | null;
  values: string[][];
}

export interface GoogleSpreadsheet {
  properties?: { title?: string };
  sheets?: { properties?: { title?: string } }[];
}

export function renderSpreadsheet(spreadsheet: GoogleSpreadsheet, valueRanges: SheetValueRange[]): RenderedContent {
  const titles = (spreadsheet.sheets ?? []).map((sheet) => sheet.properties?.title ?? "Sheet");
  let truncated = false;
  const tabs: SheetTab[] = titles.map((title, index) => ({
    title,
    range: valueRanges[index]?.range ?? null,
    values: (valueRanges[index]?.values ?? []).map((row) => row.map((cell) => String(cell ?? ""))),
  }));

  const sections = tabs.map((tab) => {
    const shownRows = tab.values.slice(0, MAX_SHEET_ROWS).map((row) => row.slice(0, MAX_SHEET_COLUMNS));
    const cut =
      tab.values.length > MAX_SHEET_ROWS || tab.values.some((row) => row.length > MAX_SHEET_COLUMNS);
    if (cut) truncated = true;
    const table = tableToMarkdown(shownRows);
    const note = cut ? `\n\n[Truncated: showing up to ${MAX_SHEET_ROWS} rows and ${MAX_SHEET_COLUMNS} columns of ${tab.values.length} rows. Read the structured representation for all values.]` : "";
    return `## ${tab.title}\n\n${table || "(empty)"}${note}`;
  });

  const heading = spreadsheet.properties?.title ? `# ${spreadsheet.properties.title}\n\n` : "";
  const capped = capMarkdown(`${heading}${sections.join("\n\n")}`);
  return {
    markdown: capped.markdown,
    structured: stripUrlFields({ title: spreadsheet.properties?.title ?? null, tabs }),
    truncated: truncated || capped.truncated,
  };
}
