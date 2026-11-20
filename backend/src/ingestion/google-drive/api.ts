import { describeGoogleError, googleRequest, isGoogleRateLimit, type GoogleRequestOptions } from "../google/request";
import type { DriveComment } from "./comments";
import type { GoogleDocument } from "./render-doc";
import type { GoogleSpreadsheet, SheetValueRange } from "./render-sheet";
import type { GooglePresentation } from "./render-slides";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES = "https://slides.googleapis.com/v1/presentations";

export const DOC_MIME = "application/vnd.google-apps.document";
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const SLIDES_MIME = "application/vnd.google-apps.presentation";
export const NATIVE_MIME_TYPES = [DOC_MIME, SHEET_MIME, SLIDES_MIME];
export const FOLDER_MIME = "application/vnd.google-apps.folder";

const FILE_FIELDS = "id,name,mimeType,driveId,modifiedTime,version,webViewLink,trashed,parents,owners(emailAddress),lastModifyingUser(displayName)";

export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly code: "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "invalid_page_token" | "request_failed",
    readonly status: number,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "DriveApiError";
  }
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  driveId?: string;
  modifiedTime?: string;
  version?: string;
  webViewLink?: string;
  trashed?: boolean;
  parents?: string[];
  owners?: Array<{ emailAddress?: string }>;
  lastModifyingUser?: { displayName?: string };
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

export interface DriveApi {
  getStartPageToken(): Promise<string>;
  listFiles(input: { q: string; pageToken?: string; pageSize?: number; driveId?: string }): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  listChanges(pageToken: string): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>;
  listFolderChildren(folderId: string, pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  getFile(fileId: string): Promise<DriveFile>;
  listSharedDrives(): Promise<Array<{ id: string; name: string }>>;
  listComments(fileId: string, startModifiedTime?: string): Promise<DriveComment[]>;
  getDocument(fileId: string): Promise<GoogleDocument>;
  getSpreadsheet(fileId: string): Promise<GoogleSpreadsheet>;
  getSheetValues(fileId: string, tabTitles: string[]): Promise<SheetValueRange[]>;
  getPresentation(fileId: string): Promise<GooglePresentation>;
}

export function createDriveApi(accessToken: string, fetchImpl: typeof fetch = fetch, requestOptions: GoogleRequestOptions = {}): DriveApi {
  async function get<T>(base: string, params: Record<string, string | string[] | boolean | number | undefined> = {}): Promise<T> {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const result = await googleRequest(() => fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } }), requestOptions);
    if (result.ok) return (await result.response.json()) as T;
    const { info, attempts } = result;
    const message = describeGoogleError("Google", info, attempts);
    if (info.status === 401) throw new DriveApiError(message, "unauthorized", 401, info.reason);
    if (info.status === 404) throw new DriveApiError(message, "not_found", 404, info.reason);
    if (isGoogleRateLimit(info)) throw new DriveApiError(message, "rate_limited", info.status, info.reason);
    if (info.status === 403) throw new DriveApiError(message, "forbidden", 403, info.reason);
    if (info.status === 400 && /page ?token/i.test(`${info.reason ?? ""} ${info.message ?? ""}`)) {
      throw new DriveApiError(message, "invalid_page_token", 400, info.reason);
    }
    throw new DriveApiError(message, "request_failed", info.status, info.reason);
  }

  const shared = { supportsAllDrives: true, includeItemsFromAllDrives: true };

  async function paginate<T>(fetchPage: (pageToken?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
    const all: T[] = [];
    let pageToken: string | undefined;
    do {
      const page = await fetchPage(pageToken);
      all.push(...page.items);
      pageToken = page.next;
    } while (pageToken);
    return all;
  }

  return {
    async getStartPageToken() {
      const json = await get<{ startPageToken: string }>(`${DRIVE}/changes/startPageToken`, { supportsAllDrives: true });
      return json.startPageToken;
    },

    // With driveId the listing covers one shared drive; without it, every drive the person can see.
    async listFiles({ q, pageToken, pageSize = 100, driveId }) {
      const json = await get<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE}/files`, {
        q,
        pageToken,
        pageSize,
        orderBy: "modifiedTime desc",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        ...(driveId ? { corpora: "drive", driveId } : { corpora: "allDrives" }),
        ...shared,
      });
      return { files: json.files ?? [], nextPageToken: json.nextPageToken };
    },

    async listFolderChildren(folderId, pageToken) {
      const json = await get<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE}/files`, {
        q: `'${folderId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' in parents and trashed = false`,
        pageToken,
        pageSize: 100,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        corpora: "allDrives",
        ...shared,
      });
      return { files: json.files ?? [], nextPageToken: json.nextPageToken };
    },

    async listChanges(pageToken) {
      const json = await get<{ changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(`${DRIVE}/changes`, {
        pageToken,
        pageSize: 100,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
        ...shared,
      });
      return { changes: json.changes ?? [], nextPageToken: json.nextPageToken, newStartPageToken: json.newStartPageToken };
    },

    getFile: (fileId) => get(`${DRIVE}/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: true }),

    listSharedDrives: () =>
      paginate(async (pageToken) => {
        const json = await get<{ drives?: Array<{ id: string; name: string }>; nextPageToken?: string }>(`${DRIVE}/drives`, {
          pageToken,
          pageSize: 100,
          fields: "nextPageToken,drives(id,name)",
        });
        return { items: json.drives ?? [], next: json.nextPageToken };
      }),

    listComments: (fileId, startModifiedTime) =>
      paginate(async (pageToken) => {
        const json = await get<{ comments?: DriveComment[]; nextPageToken?: string }>(`${DRIVE}/files/${encodeURIComponent(fileId)}/comments`, {
          pageToken,
          pageSize: 100,
          startModifiedTime,
          includeDeleted: true,
          fields: "nextPageToken,comments(content,resolved,deleted,createdTime,modifiedTime,author(displayName),quotedFileContent(value),replies(content,deleted,createdTime,modifiedTime,author(displayName)))",
        });
        return { items: json.comments ?? [], next: json.nextPageToken };
      }),

    getDocument: (fileId) => get(`${DOCS}/${encodeURIComponent(fileId)}`, { includeTabsContent: true }),

    getSpreadsheet: (fileId) => get(`${SHEETS}/${encodeURIComponent(fileId)}`, { fields: "properties.title,sheets.properties.title" }),

    async getSheetValues(fileId, tabTitles) {
      if (tabTitles.length === 0) return [];
      const json = await get<{ valueRanges?: SheetValueRange[] }>(`${SHEETS}/${encodeURIComponent(fileId)}/values:batchGet`, {
        ranges: tabTitles.map((title) => `'${title.replace(/'/g, "''")}'`),
        valueRenderOption: "FORMATTED_VALUE",
      });
      return json.valueRanges ?? [];
    },

    getPresentation: (fileId) => get(`${SLIDES}/${encodeURIComponent(fileId)}`),
  };
}
