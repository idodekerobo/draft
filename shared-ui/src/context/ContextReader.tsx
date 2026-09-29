import { useMemo, useState } from "react";
import { parseFrontmatterFields, type ContextFileEntry } from "./context-files";
import { renderMarkdown } from "./markdown";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function metaLine(entry: ContextFileEntry, snapshotCreatedAt: string | null): string {
  const fields = parseFrontmatterFields(entry.frontmatterRaw);
  const updated = fields.last_updated ?? snapshotCreatedAt;
  return [entry.label, updated ? `updated ${formatDate(updated)}` : null, fields.source ? `sources: ${fields.source}` : null]
    .filter(Boolean)
    .join(", ");
}

/** Read-only context: dimension list, then the selected document. Log entries stay desktop-only for now. */
export function ContextReader({ entries, snapshotCreatedAt, onSelect }: {
  entries: ContextFileEntry[];
  snapshotCreatedAt: string | null;
  onSelect?: (entry: ContextFileEntry) => void;
}) {
  const readable = useMemo(() => entries.filter((entry) => entry.kind !== "log"), [entries]);
  const [selectedPath, setSelectedPath] = useState(readable[0]?.relativePath ?? "");
  const [raw, setRaw] = useState(false);
  const selected = readable.find((entry) => entry.relativePath === selectedPath) ?? readable[0];
  const html = useMemo(() => (selected ? renderMarkdown(selected.content) : ""), [selected]);

  const topLevel = readable.filter((entry) => entry.kind !== "group-child");
  const groups = new Map<string, ContextFileEntry[]>();
  for (const entry of readable) {
    if (entry.kind === "group-child") groups.set(entry.groupLabel, [...(groups.get(entry.groupLabel) ?? []), entry]);
  }

  function select(entry: ContextFileEntry) {
    setSelectedPath(entry.relativePath);
    setRaw(false);
    onSelect?.(entry);
  }

  function item(entry: ContextFileEntry) {
    const active = entry.relativePath === selected?.relativePath;
    return (
      <li key={entry.relativePath}>
        <button type="button" className={`ui-context__item${active ? " ui-context__item--active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => select(entry)}>
          {entry.label}
        </button>
      </li>
    );
  }

  return (
    <div className="ui-context">
      <nav className="ui-context__list" aria-label="Context documents">
        <ul>{topLevel.map(item)}</ul>
        {[...groups].map(([label, children]) => (
          <section key={label} aria-label={label}>
            <h3 className="ui-group-label ui-context__group">{label}</h3>
            <ul>{children.map(item)}</ul>
          </section>
        ))}
      </nav>
      {selected && (
        <article className="ui-context__doc">
          <div className="ui-context__meta">
            <span>{metaLine(selected, snapshotCreatedAt)}</span>
            <button type="button" className="ui-link" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? "View formatted" : "View raw"}</button>
          </div>
          {raw
            ? <pre className="ui-context__raw">{selected.frontmatterRaw + selected.content}</pre>
            : <div className="ui-context__body ui-prose" dangerouslySetInnerHTML={{ __html: html }} />}
        </article>
      )}
    </div>
  );
}
