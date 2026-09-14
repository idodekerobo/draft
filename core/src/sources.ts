export const SOURCE_SEARCH_DEFAULT_LIMIT = 10;
export const SOURCE_SEARCH_MAX_LIMIT = 100;
export const SOURCE_RESPONSE_DEFAULT_MAX_BYTES = 32_768;
export const SOURCE_RESPONSE_MIN_MAX_BYTES = 1_024;
export const SOURCE_RESPONSE_MAX_MAX_BYTES = 262_144;
export const SOURCE_FULL_SUMMARY_MAX_BYTES = 2_048;
export const SOURCE_QUERY_MAX_CHARACTERS = 512;

export const SOURCE_REPRESENTATIONS = ["default", "transcript", "messages", "structured"] as const;
export type SourceRepresentation = (typeof SOURCE_REPRESENTATIONS)[number];

export const SOURCE_REPRESENTATION_KINDS = ["summary", "source", "mixed", "unknown"] as const;
export type SourceRepresentationKind = (typeof SOURCE_REPRESENTATION_KINDS)[number];

export const SOURCE_TIME_BASES = ["source_event", "source_created", "ingestion_fallback", "unknown"] as const;
export type SourceTimeBasis = (typeof SOURCE_TIME_BASES)[number];

export const SOURCE_ERROR_CODES = [
  "invalid_query",
  "invalid_filter",
  "invalid_limit",
  "invalid_max_bytes",
  "invalid_cursor",
  "cursor_mismatch",
  "response_budget_too_small",
  "representation_unavailable",
  "source_not_found",
  "source_superseded",
  "source_changed",
  "search_failed",
  "read_failed",
] as const;
export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];

export interface SourceAttribution {
  name: string | null;
  role: "author" | "participant" | "owner";
  provider_user_id: string | null;
}

export interface SourceDescriptor {
  source_item_id: string;
  source_version: string;
  title: string | null;
  provider: string;
  item_type: string;
  representation_kind: SourceRepresentationKind;
  occurred_at: string;
  source_time_start: string | null;
  source_time_end: string | null;
  time_basis: SourceTimeBasis;
  attribution: SourceAttribution[];
  source_url: string | null;
  available_representations: SourceRepresentation[];
  metadata_truncated: boolean;
}

export interface SourceSearchInput {
  query: string;
  provider?: string;
  type?: string[];
  since?: string;
  until?: string;
  limit?: number;
  max_bytes?: number;
  cursor?: string;
}

export interface SourceSearchResponse {
  results: Array<SourceDescriptor & {
    content_kind: "full_summary" | "excerpt";
    content: string;
  }>;
  next_cursor: string | null;
  consistency: "live";
  filters: {
    provider: string | null;
    type: string[];
    since: string | null;
    until: string | null;
  };
}

export interface SourceReadInput {
  source_item_id: string;
  representation?: SourceRepresentation;
  max_bytes?: number;
  cursor?: string;
}

export interface SourceReadResponse {
  source: SourceDescriptor;
  representation: SourceRepresentation;
  representation_version: string;
  format: "markdown" | "text" | "json";
  content: string;
  content_offset_bytes: number;
  truncated: boolean;
  next_cursor: string | null;
}

export interface SourceDomainError {
  error: {
    code: SourceErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
