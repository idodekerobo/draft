"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { DataBoundary } from "../query/DataBoundary";
import { useDraftApi } from "../query/api";
import { routinesQueryOptions } from "../query/options";
import { toast } from "../toast";
import {
  countRoutines,
  filterRoutines,
  formatRelative,
  formatWhen,
  zoneLabel,
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

const OUTCOME_LABEL = { changed: "Updated", no_change: "No changes", failure: "Failed", stale: "Stale" } as const;

function recentActivity(routine: Routine) {
  const label = routine.taskType === "synthesize_workspace" ? "Last run" : "Last check";
  if (routine.taskType === "synthesize_workspace") {
    const run = routine.lastRun;
    if (!run?.completedAt) {
      return (
        <div className="ui-routines__when" data-label={label}>
          <div className="ui-routines__status ui-routines__status--none">No result yet</div>
          <div className="ui-routines__secondary">No run recorded</div>
        </div>
      );
    }
    const failed = run.outcome === "failure" || run.status === "failed";
    const text = run.outcome ? OUTCOME_LABEL[run.outcome] : failed ? "Failed" : "Updated";
    return (
      <div className="ui-routines__when" data-label={label}>
        <div className={`ui-routines__status ${failed ? "ui-routines__status--error" : "ui-routines__status--success"}`}>{text}</div>
        <div className="ui-routines__secondary">Last ran {formatWhen(run.completedAt, routine.timezone)}</div>
      </div>
    );
  }
  return (
    <div className="ui-routines__when" data-label={label}>
      {routine.lastCheckedAt ? (
        <>
          <strong>{formatWhen(routine.lastCheckedAt, routine.timezone)}</strong>
          <div className="ui-routines__secondary">Last checked</div>
        </>
      ) : (
        <div className="ui-routines__secondary">Not checked yet</div>
      )}
    </div>
  );
}

function nextActivity(routine: Routine, onReconnect?: () => void) {
  const label = routine.taskType === "synthesize_workspace" ? "Next run" : "Next check";
  let heading: string;
  let detail: ReactNode;
  if (routine.needsReconnect) {
    heading = "Needs reconnect";
    detail = onReconnect ? (
      <button type="button" className="ui-routines__text-button" onClick={onReconnect}>Reconnect Slack</button>
    ) : null;
  } else if (!routine.enabled) {
    heading = "Paused";
    detail = "No upcoming activity";
  } else if (!routine.nextRunAt) {
    heading = "Not scheduled";
    detail = null;
  } else {
    heading = formatRelative(routine.nextRunAt);
    detail = formatWhen(routine.nextRunAt, routine.timezone);
  }
  return (
    <div className="ui-routines__when" data-label={label}>
      <strong>{heading}</strong>
      {detail && <div className="ui-routines__secondary">{detail}</div>}
    </div>
  );
}

export function RoutinesSkeleton() {
  return (
    <div role="status" aria-label="Loading routines">
      {[0, 1, 2].map((row) => (
        <div key={row} className="ui-routines__skeleton" aria-hidden="true">
          <div />
          <div />
        </div>
      ))}
    </div>
  );
}

function RoutinesList({ workspaceId, onReconnect }: { workspaceId: string; onReconnect?: () => void }) {
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
        onSuccess: () => toast.success(`${routine.title} ${enabled ? "resumed" : "paused"}.`),
        onSettled: () => setPendingFor(routine.id, false),
      },
    );
  }

  async function onSave(routine: Routine, patch: RoutinePatch) {
    await save.mutateAsync({ id: routine.id, patch });
    toast.success("Schedule saved.");
    setOpenId(null);
  }

  return (
    <>
      <div className="ui-routines__overview">
        <span><strong>{counts.active}</strong> active</span>
        <span><strong>{counts.paused}</strong> paused</span>
        <span className="ui-routines__zone">Times shown in each routine’s timezone</span>
      </div>

      <div className="ui-routines__tools">
        <div className="ui-routines__tabs" role="group" aria-label="Filter routines">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label}<span className="ui-routines__count">{counts[value]}</span>
            </button>
          ))}
        </div>
        <input
          className="ui-routines__search"
          type="search"
          placeholder="Search routines"
          aria-label="Search routines"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {visible.length === 0 ? (
        <div className="ui-routines__empty">
          <h2>{routines.length === 0 ? "No routines yet" : "No matching routines"}</h2>
          <div className="ui-routines__secondary">
            {routines.length === 0
              ? "Your routines will appear here when your workspace is set up. Contact Draft for help."
              : "Try a different search or filter."}
          </div>
          {routines.length > 0 && (
            <button
              type="button"
              className="ui-routines__text-button"
              onClick={() => {
                setFilter("all");
                setSearch("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="ui-routines__columns" aria-hidden="true">
            <span>Routine</span>
            <span>Schedule</span>
            <span>Enabled</span>
            <span>Recent activity</span>
            <span>Next activity</span>
          </div>
          {visible.map((routine) => {
            const nameId = `${labelPrefix}-${routine.id}`;
            const managed = routine.editable === "toggle_only";
            const switchLabel = `${routine.title}${routine.connectionLabel ? ` ${routine.connectionLabel}` : ""} enabled`;
            return (
              <section key={routine.id} className="ui-routines__routine" aria-labelledby={nameId}>
                <div className="ui-routines__row">
                  <div className="ui-routines__identity">
                    <button type="button" id={nameId} className="ui-routines__link" onClick={() => setOpenId(routine.id)}>
                      {routine.title}
                    </button>
                    {routine.connectionLabel && <div className="ui-routines__secondary">{routine.connectionLabel}</div>}
                  </div>
                  <div className="ui-routines__schedule">
                    <div className="ui-routines__secondary">{routine.scheduleDescription}</div>
                    <div className="ui-routines__secondary">
                      {zoneLabel(routine.timezone)}{managed ? " · Managed by Draft" : ""}
                    </div>
                  </div>
                  <div className="ui-routines__controls">
                    <button
                      type="button"
                      role="switch"
                      className="ui-routines__switch"
                      aria-checked={routine.enabled}
                      aria-label={switchLabel}
                      disabled={!canEdit || routine.needsReconnect || pending.has(routine.id)}
                      onClick={() => onToggle(routine, !routine.enabled)}
                    >
                      <i />
                    </button>
                  </div>
                  {recentActivity(routine)}
                  {nextActivity(routine, onReconnect)}
                </div>
              </section>
            );
          })}
        </>
      )}

      <p className="ui-routines__helper">
        Draft checks for new material on each schedule. Context updates and summaries run only when there’s something new to process.
      </p>

      {open && (
        <RoutineDetails
          key={open.id}
          routine={open}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onSave={(patch) => onSave(open, patch)}
        />
      )}
    </>
  );
}

/** Loading and error states match the Routines page; the title stays on screen throughout. */
export function RoutinesPanel({ workspaceId, onReconnect }: { workspaceId: string; onReconnect?: () => void }) {
  return (
    <div className="ui-routines">
      <h1 className="ui-routines__title">Routines</h1>
      <p className="ui-routines__intro">The routines that keep your company context up to date.</p>
      <DataBoundary
        fallback={<RoutinesSkeleton />}
        errorFallback={(retry) => (
          <div className="ui-routines__banner" role="alert">
            <p>Routines couldn’t load. Please try again.</p>
            <button type="button" className="ui-routines__btn" onClick={retry}>Try again</button>
          </div>
        )}
      >
        <RoutinesList workspaceId={workspaceId} onReconnect={onReconnect} />
      </DataBoundary>
    </div>
  );
}
