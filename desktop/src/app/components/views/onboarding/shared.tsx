// shared.tsx — shared UI components for onboarding steps

import { useState, type ReactNode } from "react";

// ── CopyableCmd ───────────────────────────────────────────────────────────────

export function CopyableCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  }
  return (
    <button className="onboarding__cmd" onClick={handleCopy} title="Copy to clipboard">
      <span className="onboarding__cmd-text">{cmd}</span>
      <span className="onboarding__cmd-copy">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

// ── ScanSkillRow ──────────────────────────────────────────────────────────────

export function ScanSkillRow({ name, agent, tokenCount, selected, focused, onClick }: {
  name: string;
  agent: "claude-code" | "codex";
  tokenCount: number;
  selected: boolean;
  focused?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`onboarding__skill-row${focused ? " onboarding__skill-row--focused" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
    >
      <span className="onboarding__skill-check" aria-hidden="true">{selected ? "✓" : ""}</span>
      <span className="onboarding__skill-name">{name}</span>
      <span className="onboarding__skill-badge">{agent === "claude-code" ? "Claude" : "Codex"}</span>
      <span className="onboarding__skill-tokens">~{tokenCount} tokens</span>
    </button>
  );
}

// ── CollapsibleSection ────────────────────────────────────────────────────────

export function CollapsibleSection({ label, count, expanded, onToggle, onSelectAll, onDeselectAll, allSelected, noneSelected, children }: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  allSelected?: boolean;
  noneSelected?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="onboarding__collapsible-section" role="group" aria-label={label}>
      <div className="onboarding__collapsible-header">
        <button className="onboarding__collapsible-toggle" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? "▼" : "▶"} <span>{label.toUpperCase()} ({count})</span>
        </button>
        {count > 0 && onSelectAll && onDeselectAll && (
          <span className="onboarding__collapsible-actions">
            <button onClick={onSelectAll}>Select all</button>
            <button onClick={onDeselectAll} disabled={noneSelected}>Deselect all</button>
          </span>
        )}
      </div>
      {expanded && children}
    </section>
  );
}

// ── IntegrationSetupCard ──────────────────────────────────────────────────────

export function IntegrationSetupCard({ title, description, hint, connected, expanded, onToggle, children, action }: {
  title: string;
  description: string;
  hint: string;
  connected: boolean;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
  action?: string;
}) {
  return (
    <section className="onboarding__integration-card" aria-expanded={expanded}>
      <button className="onboarding__integration-header" onClick={onToggle} aria-expanded={expanded} disabled={connected}>
        <span className="onboarding__integration-title"><span>{title}</span><small>{description}</small></span>
        <span className="onboarding__integration-status">
          {connected
            ? <><span className="onboarding__status-dot onboarding__status-dot--green" />
                <span className="onboarding__integration-badge onboarding__integration-badge--connected">Connected</span></>
            : <><small>{hint}</small>{action ?? (expanded ? "▲" : "▼")}</>}
        </span>
      </button>
      {!connected && expanded && <div className="onboarding__integration-content">{children}</div>}
    </section>
  );
}

// ── HeadlessProgress ──────────────────────────────────────────────────────────

export function HeadlessProgress({ label }: { label: string }) {
  return (
    <div className="onboarding__headless-progress" aria-live="polite">
      <span className="onboarding__spinner" />
      <span>{label}</span>
    </div>
  );
}
