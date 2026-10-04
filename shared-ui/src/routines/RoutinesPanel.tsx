"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useDraftApi } from "../query/api";
import { routinesQueryOptions } from "../query/options";
import { Toggle } from "../settings/SettingsRow";
import { toast } from "../toast";
import {
  countRoutines,
  filterRoutines,
  formatAbsolute,
  formatRelative,
  type RoutineFilter,
} from "./format";
import { RoutineDetails } from "./RoutineDetails";
import type { Routine, RoutinePatch } from "./types";
import { useRoutineMutations } from "./useRoutineMutations";

const FILTERS: Array<[RoutineFilter, string]> = [
  ["all", "All"],
  ["active", "Active"],
  ["paused", "Paused"],
];

const OUTCOME_LABEL = { changed: "Context updated", no_change: "No changes", failure: "Failed", stale: "Stale" } as const;

function recentActivity(routine: Routine) {
  if (routine.taskType === "synthesize_workspace") {
    const run = routine.lastRun;
    if (!run?.completedAt) return <span className="ui-muted">No result yet</span>;
    const label = run.outcome ? OUTCOME_LABEL[run.outcome] : run.status === "succeeded" ? "Succeeded" : "Failed";
    const failed = run.outcome === "failure" || run.status === "failed";
    return (
      <>
        <span>Last ran {formatRelative(run.completedAt)}</span>
        <span className="ui-routines__sub">
          <span className={`ui-dot ${failed ? "ui-dot--error" : "ui-dot--connected"}`} aria-hidden /> {label}
        </span>
      </>
    );
  }
  if (!routine.lastCheckedAt) return <span className="ui-muted">Not checked yet</span>;
  return <span>Last checked {formatRelative(routine.lastCheckedAt)}</span>;
}

function nextActivity(routine: Routine, onReconnect?: () => void) {
  if (routine.needsReconnect) {
    return (
      <>
        <span className="ui-routines__alert">
          <TriangleAlert size={14} aria-hidden /> Needs reconnect
        </span>
        {onReconnect && (
          <button type="button" className="ui-link ui-routines__sub" onClick={onReconnect}>Reconnect</button>
        )}
      </>
    );
  }
  if (!routine.enabled) return <span className="ui-muted">Paused</span>;
  if (!routine.nextRunAt) return <span className="ui-muted">Not scheduled</span>;
  const label = routine.taskType === "synthesize_workspace" ? "Next run" : "Next check";
  return (
    <>
      <span>{label} {formatRelative(routine.nextRunAt)}</span>
      <time className="ui-routines__sub" dateTime={routine.nextRunAt}>
        {formatAbsolute(routine.nextRunAt, routine.timezone)}
      </time>
    </>
  );
}

export function RoutinesSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading routines">
      {[0, 1, 2].map((row) => (
        <div key={row} className="ui-routines__skeleton" />
      ))}
    </div>
  );
}

export function RoutinesPanel({ workspaceId, onReconnect }: { workspaceId: string; onReconnect?: () => void }) {
  const api = useDraftApi();
  const { data } = useSuspenseQuery(routinesQueryOptions(api, workspaceId));
  const { routines, canEdit } = data;
  const [filter, setFilter] = useState<RoutineFilter>("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const labelPrefix = useId();

  const { toggle, save } = useRoutineMutations(workspaceId, (error) =>
    toast.error("Could not update the routine", { description: error.message }),
  );

  const counts = countRoutines(routines);
  const visible = filterRoutines(routines, filter, search);
  const open = routines.find((routine) => routine.id === openId) ?? null;

  function setPendingFor(id: string, isPending: boolean) {
    setPending((current) => {
      const next = new Set(current);
      if (isPending) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function onToggle(routine: Routine, enabled: boolean) {
    setPendingFor(routine.id, true);
    toggle.mutate(
      { id: routine.id, enabled },
      {
        onSuccess: () => toast.success(`${routine.title} ${enabled ? "resumed" : "paused"}`),
        onSettled: () => setPendingFor(routine.id, false),
      },
    );
  }

  async function onSave(routine: Routine, patch: RoutinePatch) {
    const updated = await save.mutateAsync({ id: routine.id, patch });
    toast.success(`${routine.title} schedule saved`, {
      description: updated.nextRunAt ? `Next run ${formatAbsolute(updated.nextRunAt, updated.timezone)}` : undefined,
    });
    setOpenId(null);
  }

  return (
    <div className="ui-routines">
      <h1 className="ui-page__title">Routines</h1>
      <p className="ui-page__intro">The routines that keep your company context up to date.</p>

      {routines.length === 0 ? (
        <p className="ui-muted">No routines yet. Contact Draft.</p>
      ) : (
        <>
          <div className="ui-routines__toolbar">
            <div className="ui-segmented" role="group" aria-label="Filter routines">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  className={`ui-segmented__option${filter === value ? " ui-segmented__option--selected" : ""}`}
                  onClick={() => setFilter(value)}
                >
                  {label} <span className="ui-routines__count">{counts[value]}</span>
                </button>
              ))}
            </div>
            <input
              className="ui-input ui-routines__search"
              type="search"
              placeholder="Search routines"
              aria-label="Search routines"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {visible.length === 0 ? (
            <p className="ui-muted ui-routines__none">No routines match your filters.</p>
          ) : (
            <table className="ui-routines__table">
              <thead>
                <tr>
                  <th scope="col">Routine</th>
                  <th scope="col">Schedule</th>
                  <th scope="col" className="ui-routines__enabled">Enabled</th>
                  <th scope="col">Recent activity</th>
                  <th scope="col">Next activity</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((routine) => {
                  const labelId = `${labelPrefix}-${routine.id}`;
                  return (
                    <tr key={routine.id}>
                      <td data-label="Routine">
                        <button type="button" id={labelId} className="ui-routines__name" onClick={() => setOpenId(routine.id)}>
                          {routine.title}
                        </button>
                        {routine.connectionLabel && <span className="ui-routines__sub">{routine.connectionLabel}</span>}
                      </td>
                      <td data-label="Schedule">{routine.scheduleDescription}</td>
                      <td data-label="Enabled" className="ui-routines__enabled">
                        <Toggle
                          checked={routine.enabled}
                          labelledBy={labelId}
                          disabled={!canEdit || routine.needsReconnect || pending.has(routine.id)}
                          onChange={(next) => onToggle(routine, next)}
                        />
                      </td>
                      <td data-label="Recent activity">{recentActivity(routine)}</td>
                      <td data-label="Next activity">{nextActivity(routine, onReconnect)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}

      {open && (
        <RoutineDetails
          key={open.id}
          routine={open}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onSave={(patch) => onSave(open, patch)}
        />
      )}
    </div>
  );
}
