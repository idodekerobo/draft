// shared.tsx — shared UI components for onboarding steps

import { useState, type ReactNode } from "react";
import { formatTokens } from "../../shared/skills";

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

export function ScanSkillRow({ name, description, descriptionTokenCount, tokenCount, selected, focused, onClick }: {
  name: string;
  description: string;
  descriptionTokenCount: number;
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
      <span className="onboarding__skill-info">
        <span className="onboarding__skill-name">{name}</span>
        {description && <span className="onboarding__skill-desc">{description}</span>}
      </span>
      <span className="onboarding__skill-tokens" data-tooltip={`Description: ~${formatTokens(descriptionTokenCount)} tokens (always loaded)\nFull skill: ~${formatTokens(tokenCount)} tokens (loaded on invocation)`}>
        ~{formatTokens(tokenCount)}
      </span>
    </button>
  );
}

// ── CollapsibleSection ────────────────────────────────────────────────────────

export function CollapsibleSection({ label, count, expanded, onToggle, onSelectAll, onDeselectAll, allSelected, noneSelected, stickyIndex, children }: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  allSelected?: boolean;
  noneSelected?: boolean;
  stickyIndex?: number;
  children?: ReactNode;
}) {
  const top = (stickyIndex ?? 0) * 36;
  return (
    <>
      <div className="onboarding__collapsible-header" role="group" aria-label={label} style={{ top }}>
        <button className="onboarding__collapsible-toggle" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? "▼" : "▶"} <span>{label.toUpperCase()} ({count})</span>
        </button>
        {count > 0 && onSelectAll && onDeselectAll && (
          <span className="onboarding__collapsible-actions">
            <button onClick={onSelectAll} disabled={allSelected}>Select all</button>
            <button onClick={onDeselectAll} disabled={noneSelected}>Deselect all</button>
          </span>
        )}
      </div>
      {expanded && children}
    </>
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
