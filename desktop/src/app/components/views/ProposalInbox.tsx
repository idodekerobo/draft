// ProposalInbox.tsx — proposal panel with contextual empty states
//
// Shows one of three states, in priority order:
//   State 1 — No integrations connected (Phase 2: reads secrets.json)
//   State 2 — Running + integrations, no proposals yet
//   State 3 — Normal proposal list
//
// State 1 detection is deferred to Phase 2 (requires reading secrets.json).
// The daemon-stopped state is handled upstream in App.tsx (DaemonStoppedOverlay)
// so this component only renders when the daemon is running.
//
// Copy rule per DESIGN.md: never use the word "daemon" in UI text.

import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines } from "diff";
import type { ProposalSummary } from "../../../rpc/schema";
import { events, rpc } from "../../rpc";

// ── Empty state components ──────────────────────────────────────────────────────

function WatchingPrompt() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">◎</div>
      <p className="empty-state__title">Draft is watching</p>
      <p className="empty-state__body">
        Proposals will appear here when Draft captures something new.
      </p>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────────

interface ProposalInboxProps {
  activeProfile: string;
  onCountChange: (count: number) => void;
}

export function ProposalInbox({ activeProfile, onCountChange }: ProposalInboxProps) {
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref so event handlers always see the current profile without re-registering.
  const activeProfileRef = useRef(activeProfile);
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);
  const selected = useMemo(
    () => proposals.find((p) => p.filename === selectedFilename) ?? proposals[0] ?? null,
    [proposals, selectedFilename],
  );

  async function refresh() {
    try {
      const next = await rpc.request.getProposals();
      setProposals(next);
      onCountChange(next.length);
      if (next.length === 0) {
        setSelectedFilename(null);
      } else if (!next.some((p) => p.filename === selectedFilename)) {
        setSelectedFilename(next[0]?.filename ?? null);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load proposals.");
    }
  }

  useEffect(() => {
    void refresh();
    // Guard: only refresh if the event is for the profile this inbox is showing.
    // The component is keyed by activeProfile in App.tsx so it remounts on switch,
    // but in-flight events from the previous profile can still arrive briefly.
    const offAdded = events.on("proposalAdded", ({ profile }) => {
      if (profile === activeProfileRef.current) void refresh();
    });
    const offBadge = events.on("badgeUpdate", ({ profile }) => {
      if (profile === activeProfileRef.current) void refresh();
    });
    return () => {
      offAdded();
      offBadge();
    };
  }, [selectedFilename]);

  async function act(kind: "accept" | "reject", filename: string) {
    const result = kind === "accept"
      ? await rpc.request.acceptProposal({ filename })
      : await rpc.request.rejectProposal({ filename });

    if (!result.ok) {
      setError(result.error ?? `${kind === "accept" ? "Accept" : "Reject"} failed.`);
      return;
    }

    setRawOpen(false);
    await refresh();
  }

  return (
    <div className="proposals">
      <div className="proposals__header">
        <span className="proposals__title">Proposals</span>
        {error && <span className="proposals__error">{error}</span>}
      </div>

      <div className="proposals__list proposals__list--split">
        {proposals.length > 0 && selected ? (
          <>
            <ProposalList
              proposals={proposals}
              selectedFilename={selected.filename}
              onSelect={(filename) => {
                setSelectedFilename(filename);
                setRawOpen(false);
              }}
            />
            <ProposalDetail
              proposal={selected}
              rawOpen={rawOpen}
              onToggleRaw={() => setRawOpen((value) => !value)}
              onAccept={() => void act("accept", selected.filename)}
              onReject={() => void act("reject", selected.filename)}
            />
          </>
        ) : (
          <WatchingPrompt />
        )}
      </div>
    </div>
  );
}

function ProposalList({
  proposals,
  selectedFilename,
  onSelect,
}: {
  proposals: ProposalSummary[];
  selectedFilename: string;
  onSelect: (filename: string) => void;
}) {
  return (
    <aside className="proposal-list" aria-label="Pending proposals">
      {proposals.map((proposal) => (
        <button
          key={proposal.filename}
          className={`proposal-row ${proposal.filename === selectedFilename ? "proposal-row--active" : ""}`}
          onClick={() => onSelect(proposal.filename)}
        >
          <span className="proposal-row__meta">
            <span>{proposal.source}</span>
            <span>{formatDate(proposal.timestamp || proposal.createdAt)}</span>
          </span>
          <span className="proposal-row__summary">{proposal.summary}</span>
          <span className="proposal-row__tags">
            <span>{proposal.dimension}</span>
            <span>{proposal.action}</span>
          </span>
        </button>
      ))}
    </aside>
  );
}

function ProposalDetail({
  proposal,
  rawOpen,
  onToggleRaw,
  onAccept,
  onReject,
}: {
  proposal: ProposalSummary;
  rawOpen: boolean;
  onToggleRaw: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const diff = diffLines(proposal.currentContent, proposal.body);

  return (
    <section className="proposal-detail">
      <header className="proposal-detail__header">
        <div className="proposal-detail__meta">
          <span className="proposal-detail__source">{proposal.source}</span>
          <span>{proposal.dimension}</span>
          <span>{formatDate(proposal.timestamp || proposal.createdAt)}</span>
        </div>
        <h2 className="proposal-detail__title">{proposal.summary}</h2>
      </header>

      <div className="proposal-detail__body">
        {rawOpen ? (
          <pre className="proposal-raw">{proposal.body || "(empty proposal)"}</pre>
        ) : (
          <pre className="proposal-diff" aria-label="Proposal diff">
            {diff.map((part, index) => (
              <DiffPart key={`${index}-${part.value.length}`} part={part} />
            ))}
          </pre>
        )}
      </div>

      <footer className="proposal-detail__footer">
        <button className="proposal-action proposal-action--primary" onClick={onAccept}>Accept</button>
        <button className="proposal-action proposal-action--ghost" onClick={onReject}>Reject</button>
        <button className="proposal-action proposal-action--link" onClick={onToggleRaw}>
          {rawOpen ? "View diff" : "View raw"}
        </button>
      </footer>
    </section>
  );
}

function DiffPart({ part }: { part: { added?: boolean; removed?: boolean; value: string } }) {
  const className = part.added
    ? "proposal-diff__line proposal-diff__line--added"
    : part.removed
      ? "proposal-diff__line proposal-diff__line--removed"
      : "proposal-diff__line";
  const prefix = part.added ? "+ " : part.removed ? "- " : "  ";

  return (
    <>
      {part.value.split("\n").map((line, index, arr) => {
        if (index === arr.length - 1 && line === "") return null;
        return <span className={className} key={`${index}-${line}`}>{prefix}{line}</span>;
      })}
    </>
  );
}

function formatDate(value: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
