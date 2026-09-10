const GRANOLA_API_BASE_URL = "https://public-api.granola.ai/v1";

export interface GranolaNoteSpeaker {
  source: string;
  diarization_label?: string;
}

export interface GranolaTranscriptItem {
  speaker: GranolaNoteSpeaker;
  text: string;
}

export interface GranolaNoteOwner {
  name: string;
  email: string;
}

export interface GranolaNote {
  id: string;
  title: string;
  owner?: GranolaNoteOwner;
  summary?: string;
  transcript?: GranolaTranscriptItem[];
  created_at?: string;
  updated_at?: string;
}

export class GranolaTranscriptTooLargeError extends Error {
  constructor(public readonly noteId: string) {
    super(`Granola transcript for note ${noteId} is too large to return inline`);
    this.name = "GranolaTranscriptTooLargeError";
  }
}

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}` };
}

async function parseErrorBody(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

/**
 * Fetches one Granola note with its transcript inline. A still-processing
 * or never-summarized note 404s here -- callers treat that like any other
 * fetch error rather than special-casing it.
 */
export async function fetchGranolaNote(apiToken: string, noteId: string): Promise<GranolaNote> {
  const response = await fetch(`${GRANOLA_API_BASE_URL}/notes/${noteId}?include=transcript`, {
    headers: authHeaders(apiToken),
  });

  if (response.status === 413) {
    throw new GranolaTranscriptTooLargeError(noteId);
  }
  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new Error(`Granola API request failed for note ${noteId}: ${response.status} ${response.statusText} ${body}`);
  }

  return (await response.json()) as GranolaNote;
}

/** Fetches a note, falling back to a separate transcript fetch when the inline one is too large. */
export async function fetchGranolaNoteWithTranscriptFallback(
  apiToken: string,
  noteId: string,
): Promise<GranolaNote> {
  try {
    return await fetchGranolaNote(apiToken, noteId);
  } catch (error) {
    if (!(error instanceof GranolaTranscriptTooLargeError)) throw error;

    const [noteResponse, transcriptResponse] = await Promise.all([
      fetch(`${GRANOLA_API_BASE_URL}/notes/${noteId}`, { headers: authHeaders(apiToken) }),
      fetch(`${GRANOLA_API_BASE_URL}/notes/${noteId}/transcript`, { headers: authHeaders(apiToken) }),
    ]);

    if (!noteResponse.ok) {
      const body = await parseErrorBody(noteResponse);
      throw new Error(`Granola API request failed for note ${noteId}: ${noteResponse.status} ${noteResponse.statusText} ${body}`);
    }
    if (!transcriptResponse.ok) {
      const body = await parseErrorBody(transcriptResponse);
      throw new Error(`Granola API request failed for transcript ${noteId}: ${transcriptResponse.status} ${transcriptResponse.statusText} ${body}`);
    }

    const note = (await noteResponse.json()) as GranolaNote;
    const transcript = (await transcriptResponse.json()) as { transcript?: GranolaTranscriptItem[] };
    return { ...note, transcript: transcript.transcript ?? [] };
  }
}

export interface ListGranolaNotesResult {
  notes: GranolaNote[];
  hasMore: boolean;
  cursor?: string;
}

/** Lists notes created after a timestamp, one page at a time. */
export async function listGranolaNotes(
  apiToken: string,
  options: { createdAfter: string; cursor?: string },
): Promise<ListGranolaNotesResult> {
  const params = new URLSearchParams({ created_after: options.createdAfter });
  if (options.cursor) params.set("cursor", options.cursor);

  const response = await fetch(`${GRANOLA_API_BASE_URL}/notes?${params.toString()}`, {
    headers: authHeaders(apiToken),
  });
  if (!response.ok) {
    const body = await parseErrorBody(response);
    throw new Error(`Granola API request failed listing notes: ${response.status} ${response.statusText} ${body}`);
  }

  const payload = (await response.json()) as { notes?: GranolaNote[]; hasMore?: boolean; cursor?: string };
  return {
    notes: payload.notes ?? [],
    hasMore: Boolean(payload.hasMore),
    cursor: payload.cursor,
  };
}

/**
 * Every note from the last `sinceDays` days, paginated. The 250ms delay
 * between pages keeps a large backfill under Granola's 5 req/s rate limit.
 */
export async function listGranolaNotesSince(
  apiToken: string,
  sinceDays: number,
  deps: { now?: () => Date; delayMs?: (ms: number) => Promise<void> } = {},
): Promise<GranolaNote[]> {
  const now = deps.now ?? (() => new Date());
  const delay = deps.delayMs ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createdAfter = new Date(now().getTime() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const notes: GranolaNote[] = [];
  let cursor: string | undefined;
  do {
    const page = await listGranolaNotes(apiToken, { createdAfter, cursor });
    notes.push(...page.notes);
    cursor = page.hasMore ? page.cursor : undefined;
    if (cursor) await delay(250);
  } while (cursor);

  return notes;
}
