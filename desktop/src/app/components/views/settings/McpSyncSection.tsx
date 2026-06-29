import { useEffect, useMemo, useState } from "react";
import type { McpConflict, McpManifest, McpManifestEntry, PendingMcpEntry, PendingCredentialMcp } from "../../../../rpc/schema";
import { rpc, events } from "../../../rpc";
import { AGENT_LABELS } from "../../shared/skills";

interface McpSyncSectionProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
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

// ── CredentialPrompt ──────────────────────────────────────────────────────────
// Shown when team MCPs have pending_secrets that the user must supply.

function CredentialPrompt({ mcps, onSaved }: {
  mcps: PendingCredentialMcp[];
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  if (mcps.length === 0) return null;

  async function handleSave(mcpName: string, envVar: string) {
    const value = values[`${mcpName}:${envVar}`];
    if (!value?.trim()) return;
    setSaving(`${mcpName}:${envVar}`);
    try {
      const result = await rpc.request.setMcpSecret({ name: mcpName, envVar, value: value.trim() });
      if (result.ok) {
        setSaved((prev) => new Set([...prev, `${mcpName}:${envVar}`]));
        if (result.nowInstalled) onSaved();
      }
    } catch { /* non-fatal */ }
    finally { setSaving(null); }
  }

  return (
    <div className="mcp-credential-prompt">
      <div className="mcp-credential-prompt__header">
        <span className="app-row__status-dot app-row__status-dot--pending" />
        <span className="mcp-credential-prompt__title">Team MCP servers need credentials</span>
      </div>
      {mcps.map((mcp) => (
        <div key={mcp.name} className="mcp-credential-prompt__server">
          <div className="mcp-credential-prompt__server-name">
            {mcp.name}
            <span className="app-row__meta"> · {mcpDisplayUrl(mcp.url)}</span>
          </div>
          {mcp.required_secrets.map((envVar) => {
            const key = `${mcp.name}:${envVar}`;
            const isSaved = saved.has(key);
            return (
              <div key={envVar} className="mcp-credential-prompt__secret-row">
                <label className="mcp-credential-prompt__label">{envVar}</label>
                {isSaved ? (
                  <span className="mcp-credential-prompt__saved">Saved</span>
                ) : (
                  <>
                    <input
                      type="password"
                      className="mcp-credential-prompt__input"
                      placeholder="Paste API key…"
                      value={values[key] ?? ""}
                      onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                      aria-label={`${envVar} for ${mcp.name}`}
                    />
                    <button
                      className="app-row__connect"
                      onClick={() => void handleSave(mcp.name, envVar)}
                      disabled={saving === key || !values[key]?.trim()}
                    >
                      {saving === key ? "Saving…" : "Save"}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── SyncedMcpGroup ────────────────────────────────────────────────────────────

function SyncedMcpGroup({ mcps, onRemove, onPromote, onDemote, removingId, promotingId, demotingId, collabConfigured }: {
  mcps: McpManifestEntry[];
  onRemove: (mcp: McpManifestEntry) => void;
  onPromote: (mcpId: string) => void;
  onDemote: (mcpId: string) => void;
  removingId: string | null;
  promotingId: string | null;
  demotingId: string | null;
  collabConfigured: boolean;
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
              const isTeam = mcp.source === "team";
              const hasPendingSecrets = mcp.pending_secrets && mcp.pending_secrets.length > 0;
              return (
                <div key={mcp.id} className="app-row">
                  <div className="app-row__left">
                    <span className={`app-row__status-dot ${hasPendingSecrets ? "app-row__status-dot--pending" : "app-row__status-dot--on"}`} />
                    <div className="app-row__text">
                      <div className="app-row__name-row">
                        <span className="app-row__name">{mcp.name}</span>
                        {isTeam && <span className="app-row__badge app-row__badge--team">Team</span>}
                      </div>
                      <span className="app-row__meta">
                        {mcpDisplayUrl(mcp.sync_canonical.url)}
                        {!isTeam && <> · {AGENT_LABELS[mcp.source_agent]}</>}
                        {syncTargets.length > 0 && !hasPendingSecrets && (
                          <> · synced to {syncTargets.map((a) => AGENT_LABELS[a]).join(", ")}</>
                        )}
                        {hasPendingSecrets && (
                          <> · <span style={{ color: "var(--color-status-yellow)" }}>needs credentials</span></>
                        )}
                      </span>
                    </div>
                  </div>
                  {isTeam ? (
                    <div className="app-row__actions">
                      <button
                        className="app-row__disconnect"
                        onClick={() => onDemote(mcp.id)}
                        disabled={demotingId === mcp.id}
                      >
                        {demotingId === mcp.id ? "Removing…" : "Remove from team"}
                      </button>
                    </div>
                  ) : (
                    <div className="app-row__actions">
                      {collabConfigured && (
                        <button
                          className="app-row__connect app-row__connect--secondary"
                          onClick={() => onPromote(mcp.id)}
                          disabled={promotingId === mcp.id}
                        >
                          {promotingId === mcp.id ? "Sharing…" : "Share with team"}
                        </button>
                      )}
                      <button
                        className="app-row__disconnect"
                        onClick={() => onRemove(mcp)}
                        disabled={removingId === mcp.id}
                      >
                        {removingId === mcp.id ? "Removing…" : "Remove"}
                      </button>
                    </div>
                  )}
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

export function McpSyncSection({ onError, onNotice }: McpSyncSectionProps) {
  const [manifest, setManifest]               = useState<McpManifest | null>(null);
  const [pending, setPending]                 = useState<PendingMcpEntry[]>([]);
  const [conflicts, setConflicts]             = useState<McpConflict[]>([]);
  const [scanning, setScanning]               = useState(false);
  const [approving, setApproving]             = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);
  const [removingId, setRemovingId]           = useState<string | null>(null);
  const [promotingId, setPromotingId]         = useState<string | null>(null);
  const [demotingId, setDemotingId]           = useState<string | null>(null);
  const [exitingPendingIds, setExitingPendingIds] = useState<Set<string>>(new Set());
  const [collabConfigured, setCollabConfigured] = useState(false);

  async function scan() {
    setScanning(true);
    try {
      const [pendingResult, manifestResult, collabResult] = await Promise.all([
        rpc.request.getMcpPending(),
        rpc.request.getMcpManifest(),
        rpc.request.getCollabConfigured(),
      ]);
      setPending([...pendingResult.pending].sort((a, b) => a.name.localeCompare(b.name)));
      setConflicts(pendingResult.conflicts);
      setManifest(manifestResult);
      setCollabConfigured(collabResult.configured);
    } catch {
      onError("Could not scan MCP configurations.");
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => { void scan(); }, []);

  // Re-scan when the main process reports MCPs changed (e.g. after draft load).
  useEffect(() => events.on("mcpsChanged", () => { void scan(); }), []);

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

  async function handlePromote(mcpId: string) {
    setPromotingId(mcpId);
    try {
      const result = await rpc.request.promoteMcpToTeam({ mcpId });
      if (!result.ok) { onError(result.error ?? "Could not share MCP with team."); return; }
      await scan();
    } catch {
      onError("Failed to share MCP with team.");
    } finally {
      setPromotingId(null);
    }
  }

  async function handleDemote(mcpId: string) {
    setDemotingId(mcpId);
    try {
      const result = await rpc.request.demoteMcpFromTeam({ mcpId });
      if (!result.ok) { onError(result.error ?? "Could not remove MCP from team."); return; }
      await scan();
      onNotice("Removed from your team context. Run /draft-publish-team to push the change to your team.");
    } catch {
      onError("Failed to remove MCP from team.");
    } finally {
      setDemotingId(null);
    }
  }

  const syncedMcps = useMemo(
    () => (manifest ? Object.values(manifest.mcps).filter((m) => m.removed_at === null) : []),
    [manifest],
  );

  const pendingCredentialMcps = useMemo(
    () => syncedMcps.filter((m) => m.pending_secrets && m.pending_secrets.length > 0).map((m) => ({
      name: m.name,
      url: m.sync_canonical.url,
      required_secrets: m.pending_secrets!,
    })),
    [syncedMcps],
  );

  const isLoading = manifest === null;
  const isEmpty = !isLoading && pending.length === 0 && conflicts.length === 0 && syncedMcps.length === 0;

  return (
    <section className="settings__section settings__section--tool-sync settings__section--mcp-sync">
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

        {!isLoading && pendingCredentialMcps.length > 0 && (
          <CredentialPrompt
            mcps={pendingCredentialMcps}
            onSaved={() => void scan()}
          />
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
            onPromote={handlePromote}
            onDemote={handleDemote}
            removingId={removingId}
            promotingId={promotingId}
            demotingId={demotingId}
            collabConfigured={collabConfigured}
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
