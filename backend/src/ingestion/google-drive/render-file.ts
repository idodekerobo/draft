import { DOC_MIME, SHEET_MIME, SLIDES_MIME, DriveApiError, type DriveApi } from "./api";
import { commentsHash, withComments } from "./comments";
import type { RenderedContent } from "./render-common";
import { renderDocument } from "./render-doc";
import { renderSpreadsheet } from "./render-sheet";
import { renderPresentation } from "./render-slides";

export interface RenderedFile extends RenderedContent {
  commentsHash: string;
}

export function sheetReadsFor(mimeType: string | undefined): number {
  return mimeType === SHEET_MIME ? 2 : 0;
}

// One entry point for sync and live reads, so both return the same output.
export async function renderDriveFile(api: DriveApi, file: { id: string; mimeType?: string }): Promise<RenderedFile | null> {
  let rendered: RenderedContent;
  if (file.mimeType === DOC_MIME) {
    rendered = renderDocument(await api.getDocument(file.id));
  } else if (file.mimeType === SHEET_MIME) {
    const spreadsheet = await api.getSpreadsheet(file.id);
    const titles = (spreadsheet.sheets ?? []).map((sheet) => sheet.properties?.title ?? "Sheet");
    rendered = renderSpreadsheet(spreadsheet, await api.getSheetValues(file.id, titles));
  } else if (file.mimeType === SLIDES_MIME) {
    rendered = renderPresentation(await api.getPresentation(file.id));
  } else {
    return null;
  }

  // Comments are optional context: a file whose comments cannot be read still ingests.
  const comments = await api.listComments(file.id).catch((error) => {
    if (error instanceof DriveApiError && (error.code === "forbidden" || error.code === "not_found")) return [];
    throw error;
  });
  return { ...withComments(rendered, comments), commentsHash: commentsHash(comments) };
}
