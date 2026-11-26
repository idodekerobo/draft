// How pi-durable's records map to the three embedded agent tables: JSON text, indexed strings, and a document's address columns.
import type { DocumentAddress, DocumentCreate, DocumentRecord } from "@earendil-works/pi-durable";

export type Cell = string | number | boolean | null;

export const parseRecord = <T>(value: unknown): T => (typeof value === "string" ? (JSON.parse(value) as T) : (value as T));
export const encodeJson = (value: unknown): string => JSON.stringify(value);

/** An indexed string is stored as its JSON encoding, so it is lossless whatever the string holds. */
export const encodeIndexedString = (value: string): string => JSON.stringify(value);

export const scopeColumns = (scope: DocumentRecord["scope"]): { scopeKind: string; ownerId: number } => {
  switch (scope.kind) {
    case "session":
      return { scopeKind: "session", ownerId: 0 };
    case "conversation":
      return { scopeKind: "conversation", ownerId: scope.conversationId };
    case "task":
      return { scopeKind: "task", ownerId: scope.taskId };
  }
};

export const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => ({
  kind: encodeIndexedString(address.kind),
  ...scopeColumns(address.scope),
  family: address.key === undefined ? 0 : 1,
  keyValue: encodeIndexedString(address.key ?? ""),
});

export const addressColumnsKey = (kind: string, scopeKind: string, ownerId: number, family: number, keyValue: string): string =>
  JSON.stringify([kind, scopeKind, ownerId, family, keyValue]);

export const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
  const parts = addressParts(address);
  return addressColumnsKey(parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue);
};

/** A document that keeps only its current state: its revisions go at each new base and at retirement. */
export const isCurrentOnly = (record: DocumentRecord): boolean => record.scope.kind !== "conversation" || record.history === "latest";
