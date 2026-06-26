import { useEffect, useMemo, useState } from "react";
import type { McpConflict, McpManifest, McpManifestEntry, PendingMcpEntry } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { AGENT_LABELS } from "../../shared/skills";

interface McpSyncSectionProps {
  onError: (message: string) => void;
}

function mcpDisplayUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

// ── PendingMcpGroup ───────────────────────────────────────────────────────────

function PendingMcpGroup({ pending, onApprove, approving, exitingIds }: {
  pending: PendingMcpEntry[];
  onApprove: (mcps: PendingMcpEntry[]) => void;
  approving: boolean;
  exitingIds: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");

  if (pending.length === 0) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? pending.filter((p) => p.name.toLowerCase().includes(normalizedQuery))
    : pending;

  return (
    <div>
      <button
        className="skill-agent-group__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="skill-agent-group__toggle">{expanded ? "▼" : "▶"}</span>
        <span className="skill-agent-group__label">
          {pending.length} new MCP server{pending.length !== 1 ? "s" : ""} detected
        </span>
        <span className="skill-agent-group__count">pending sync</span>
      </button>

      {expanded && (
        <>
          <div className="skill-sync__filter-bar">
            <input
              className="skill-sync__filter-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter pending MCP servers"
            />
            {query && (
              <button className="skill-sync__filter-clear" onClick={() => setQuery("")} aria-label="Clear filter">✕</button>
            )}
          </div>

          <div className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__meta">
                  Sync to share these servers across both Claude Code and Codex
                </span>
              </div>
            </div>
            <button
              className="app-row__connect"
              onClick={() => onApprove(pending)}
              disabled={approving}
            >
              {approving ? "Syncing…" : "Sync all"}
            </button>
          </div>

          <div className="skill-sync__section-items">
            {filtered.map((p) => (
              <div
                key={p.id}
                className={`skill-row-anim${exitingIds.has(p.id) ? " skill-row-anim--exit-left" : ""}`}
              >
                <div className="app-row">
                  <div className="app-row__left">
                    <span className="app-row__status-dot app-row__status-dot--pending" />
                    <div className="app-row__text">
                      <span className="app-row__name">{p.name}</span>
                      <span className="app-row__meta">
                        {AGENT_LABELS[p.source_agent]} · {mcpDisplayUrl(p.canonical.url)}
                      </span>
                    </div>
                  </div>
                  <button
                    className="app-row__connect"
                    onClick={() => onApprove([p])}
                    disabled={approving}
                  >
                    Sync
                  </button>
                </div>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="app-row">
                <span className="app-row__meta" style={{ padding: "0 20px" }}>No servers match &ldquo;{query}&rdquo;</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── McpConflictGroup ──────────────────────────────────────────────────────────

function McpConflictGroup({ conflict, onResolve, resolving }: {
  conflict: McpConflict;
  onResolve: (name: string, agent: "claude-code" | "codex") => void;
  resolving: boolean;
}) {
  return (
    <div>
      <div className="skill-agent-group__header">
        <span className="skill-agent-group__label">Conflict: &ldquo;{conflict.name}&rdquo;</span>
        <span className="skill-agent-group__count">both agents have this server — pick a source</span>
      </div>

      <div className="app-row">
        <div className="app-row__left">
          <span className="app-row__status-dot app-row__status-dot--pending" />
          <div className="app-row__text">
            <span className="app-row__name">Use Claude Code&apos;s version</span>
            <span className="app-row__hint">{mcpDisplayUrl(conflict["claude-code"].canonical.url)}</span>
          </div>
        </div>
        <button
          className="app-row__connect"
          onClick={() => onResolve(conflict.name, "claude-code")}
          disabled={resolving}
        >
          Use this
        </button>
      </div>

      <div className="app-row">
        <div className="app-row__left">
          <span className="app-row__status-dot app-row__status-dot--pending" />
          <div className="app-row__text">
            <span className="app-row__name">Use Codex&apos;s version</span>
            <span className="app-row__hint">{mcpDisplayUrl(conflict.codex.canonical.url)}</span>
          </div>
        </div>
        <button
          className="app-row__connect"
          onClick={() => onResolve(conflict.name, "codex")}
          disabled={resolving}
        >
          Use this
        </button>
      </div>
    </div>
  );
}

// ── SyncedMcpGroup ────────────────────────────────────────────────────────────

function SyncedMcpGroup({ mcps, onRemove, removingId }: {
  mcps: McpManifestEntry[];
  onRemove: (mcp: McpManifestEntry) => void;
  removingId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");

  if (mcps.length === 0) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? mcps.filter((m) => m.name.toLowerCase().includes(normalizedQuery))
    : mcps;

  return (
    <div className="skill-agent-group">
      <button
        className="skill-agent-group__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="skill-agent-group__toggle">{expanded ? "▼" : "▶"}</span>
        <span className="skill-agent-group__label">Synced MCP servers</span>
        <span className="skill-agent-group__count">{mcps.length} synced</span>
      </button>
      {expanded && (
        <>
          <div className="skill-sync__filter-bar">
            <input
              className="skill-sync__filter-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter synced MCP servers"
            />
            {query && (
              <button className="skill-sync__filter-clear" onClick={() => setQuery("")} aria-label="Clear filter">✕</button>
            )}
          </div>
          <div className="skill-sync__section-items">
            {filtered.map((mcp) => {
              const syncTargets = Object.keys(mcp.synced_to) as Array<"claude-code" | "codex">;
              return (
                <div key={mcp.id} className="app-row">
                  <div className="app-row__left">
                    <span className="app-row__status-dot app-row__status-dot--on" />
                    <div className="app-row__text">
                      <span className="app-row__name">{mcp.name}</span>
                      <span className="app-row__meta">
                        {AGENT_LABELS[mcp.source_agent]} · {mcpDisplayUrl(mcp.sync_canonical.url)}
                        {syncTargets.length > 0 && (
                          <> · synced to {syncTargets.map((a) => AGENT_LABELS[a]).join(", ")}</>
                        )}
                      </span>
                    </div>
                  </div>
                  <button
                    className="app-row__disconnect"
                    onClick={() => onRemove(mcp)}
                    disabled={removingId === mcp.id}
                  >
                    {removingId === mcp.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="app-row">
                <span className="app-row__meta" style={{ padding: "0 20px" }}>No servers match &ldquo;{query}&rdquo;</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── McpSyncSection ────────────────────────────────────────────────────────────

const ANIM_DURATION_MS = 260;

export function McpSyncSection({ onError }: McpSyncSectionProps) {
  const [manifest, setManifest]               = useState<McpManifest | null>(null);
  const [pending, setPending]                 = useState<PendingMcpEntry[]>([]);
  const [conflicts, setConflicts]             = useState<McpConflict[]>([]);
  const [scanning, setScanning]               = useState(false);
  const [approving, setApproving]             = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);
  const [removingId, setRemovingId]           = useState<string | null>(null);
  const [exitingPendingIds, setExitingPendingIds] = useState<Set<string>>(new Set());

  async function scan() {
    setScanning(true);
    try {
      const [pendingResult, manifestResult] = await Promise.all([
        rpc.request.getMcpPending(),
        rpc.request.getMcpManifest(),
      ]);
      setPending([...pendingResult.pending].sort((a, b) => a.name.localeCompare(b.name)));
      setConflicts(pendingResult.conflicts);
      setManifest(manifestResult);
    } catch {
      onError("Could not scan MCP configurations.");
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => { void scan(); }, []);

  async function handleApprove(mcpsToApprove: PendingMcpEntry[]) {
    const ids = new Set(mcpsToApprove.map((m) => m.id));
    setExitingPendingIds(ids);
    await new Promise((r) => setTimeout(r, ANIM_DURATION_MS));
    setApproving(true);
    try {
      const result = await rpc.request.approveMcps({ mcps: mcpsToApprove });
      if (!result.ok) { onError(result.error ?? "Could not sync MCP servers."); return; }
      await scan();
    } catch {
      onError("MCP sync failed.");
    } finally {
      setApproving(false);
      setExitingPendingIds(new Set());
    }
  }

  async function handleResolveConflict(name: string, authoritative_agent: "claude-code" | "codex") {
    setResolvingConflict(name);
    try {
      const result = await rpc.request.resolveMcpConflict({ name, authoritative_agent });
      if (!result.ok) { onError(result.error ?? "Could not resolve conflict."); return; }
      await scan();
    } catch {
      onError("Conflict resolution failed.");
    } finally {
      setResolvingConflict(null);
    }
  }

  async function handleRemove(mcp: McpManifestEntry) {
    setRemovingId(mcp.id);
    try {
      const result = await rpc.request.removeMcp({ id: mcp.id });
      if (!result.ok) { onError(result.error ?? "Could not remove MCP server."); return; }
      await scan();
    } catch {
      onError("MCP removal failed.");
    } finally {
      setRemovingId(null);
    }
  }

  const syncedMcps = useMemo(
    () => (manifest ? Object.values(manifest.mcps).filter((m) => m.removed_at === null) : []),
    [manifest],
  );

  const isLoading = manifest === null;
  const isEmpty = !isLoading && pending.length === 0 && conflicts.length === 0 && syncedMcps.length === 0;

  return (
    <section className="settings__section">
      <div className="settings__section-header">
        <h2 className="settings__section-label">Sync MCP Servers</h2>
        <button
          className="app-row__connect settings__section-action"
          onClick={() => void scan()}
          disabled={scanning}
        >
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <div className="settings__rows">
        {isLoading && (
          <div className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__meta">
                  {scanning ? "Scanning MCP configurations…" : "Loading…"}
                </span>
              </div>
            </div>
          </div>
        )}

        {!isLoading && pending.length > 0 && (
          <PendingMcpGroup
            pending={pending}
            onApprove={handleApprove}
            approving={approving}
            exitingIds={exitingPendingIds}
          />
        )}

        {!isLoading && conflicts.map((conflict) => (
          <McpConflictGroup
            key={conflict.name}
            conflict={conflict}
            onResolve={handleResolveConflict}
            resolving={resolvingConflict === conflict.name}
          />
        ))}

        {!isLoading && syncedMcps.length > 0 && (
          <SyncedMcpGroup
            mcps={syncedMcps}
            onRemove={handleRemove}
            removingId={removingId}
          />
        )}

        {isEmpty && (
          <div className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__name">No MCP servers found</span>
                <span className="app-row__meta">
                  Add MCP servers to Claude Code or Codex and they&apos;ll appear here
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
