export const COLUMN_DEFAULT_PX = 260;
export const COLUMN_MIN_PX = 220;
export const COLUMN_MAX_PX = 400;
export const MAIN_MIN_PX = 360;

const OPEN_KEY = "draft.sessions.columnOpen";
const WIDTH_KEY = "draft.sessions.columnWidth";

/** The column stays within 220-400 px and leaves the session area at least 360 px. */
export function clampColumnWidth(width: number, containerWidth: number): number {
  const max = Math.max(COLUMN_MIN_PX, Math.min(COLUMN_MAX_PX, containerWidth - MAIN_MIN_PX));
  return Math.round(Math.min(max, Math.max(COLUMN_MIN_PX, width)));
}

export interface ColumnState {
  open: boolean;
  width: number;
}

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function readColumnState(storage: ReadableStorage | null): ColumnState {
  try {
    const width = Number(storage?.getItem(WIDTH_KEY));
    return {
      open: storage?.getItem(OPEN_KEY) !== "0",
      width: Number.isFinite(width) && width >= COLUMN_MIN_PX && width <= COLUMN_MAX_PX ? width : COLUMN_DEFAULT_PX,
    };
  } catch {
    return { open: true, width: COLUMN_DEFAULT_PX };
  }
}

export function writeColumnState(storage: WritableStorage | null, state: ColumnState): void {
  try {
    storage?.setItem(OPEN_KEY, state.open ? "1" : "0");
    storage?.setItem(WIDTH_KEY, String(state.width));
  } catch {
    // A blocked or full store only means the choice is not remembered.
  }
}

const RECENT_KEY = "draft.sessions.recentFolders";
const RECENT_MAX = 8;

export function readRecentFolders(storage: ReadableStorage | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && p !== "").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** The folder just used goes first; a repeat moves up instead of doubling. */
export function rememberFolder(storage: (ReadableStorage & WritableStorage) | null, folder: string): string[] {
  const next = [folder, ...readRecentFolders(storage).filter((f) => f !== folder)].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the list still works for this run.
  }
  return next;
}
