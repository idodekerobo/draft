"use client";

import { useState } from "react";

// ── CopyableCmd ───────────────────────────────────────────────────────────────

export function CopyableCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    // If the clipboard is blocked, the command text stays selectable.
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    }).catch(() => {});
  }
  return (
    <span className="ui-copy-cmd">
      <code className="ui-copy-cmd__text">{cmd}</code>
      <button type="button" className="ui-btn" onClick={handleCopy} aria-label={copied ? "Copied" : `Copy ${cmd}`}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="ui-visually-hidden" role="status">{copied ? "Copied" : ""}</span>
    </span>
  );
}

// ── CopyButton ────────────────────────────────────────────────────────────────

/** Outlined copy action for text too long to show inline, such as the agent setup prompt. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    }).catch(() => {});
  }
  return (
    <>
      <button type="button" className="ui-btn" onClick={handleCopy}>{copied ? "Copied" : label}</button>
      <span className="ui-visually-hidden" role="status">{copied ? "Copied" : ""}</span>
    </>
  );
}

// ── Setup dimensions ─────────────────────────────────────────────────────────

export const DEFAULT_SETUP_DIMENSIONS = ["company", "product", "team", "priorities"];

// Mirrors core/src/agents/prompts/setup.ts's DIMENSION_GUIDANCE — kept as a
// separate copy since the desktop app doesn't depend on core/.
export const DEFAULT_DIMENSION_DESCRIPTIONS: Record<string, string> = {
  company: "name, what they build, business model, stage, target market, key constraints",
  product: "product name, problem it solves, target user, key features, current state, open hypotheses",
  team: "who's on the team, roles, structure, how decisions get made",
  priorities: "active TODOs, current sprint goal, blockers, what success looks like",
};

export interface DimensionHint {
  dimensionName: string;
  dimensionDescription: string;
}

export function toDimensionHints(names: string[], descriptions?: Record<string, string>): DimensionHint[] {
  return names.map((name) => ({
    dimensionName: name,
    dimensionDescription: descriptions?.[name]?.trim() || DEFAULT_DIMENSION_DESCRIPTIONS[name] || `User-defined dimension: ${name}`,
  }));
}

/** Seeds a descriptions map for the given dimension names, pre-filled with the
 *  default guidance where one exists (empty string for custom dims). */
export function defaultDimensionDescriptions(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, DEFAULT_DIMENSION_DESCRIPTIONS[name] ?? ""]));
}
