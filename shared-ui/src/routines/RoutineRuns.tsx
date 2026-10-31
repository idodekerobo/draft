"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { DataBoundary } from "../query/DataBoundary";
import { useDraftApi } from "../query/api";
import { routineRunsQueryOptions } from "../query/options";
import { formatDuration, formatWhen } from "./format";
import type { OpenRun, Routine, RoutineRun, RoutineRunStatus } from "./types";

const STATUS_LABEL: Record<RoutineRunStatus, string> = { running: "Running", completed: "Completed", failed: "Failed" };

export function RunStatus({ status }: { status: RoutineRunStatus }) {
  return <span className={`ui-routines__status ui-routines__status--${status}`}>{STATUS_LABEL[status]}</span>;
}

function RunsSkeleton() {
  return (
    <div className="ui-routines__runs-skeleton" role="status" aria-label="Loading runs">
      <div aria-hidden="true" />
      <div aria-hidden="true" />
    </div>
  );
}

function RunRow({ run, timezone, onOpen }: { run: RoutineRun; timezone: string; onOpen?: (run: RoutineRun) => void }) {
  const detail = run.endedAt ? formatDuration(run.startedAt, run.endedAt) : null;
  const content = (
    <>
      <RunStatus status={run.status} />
      <span className="ui-routines__run-when">{formatWhen(run.startedAt, timezone)}</span>
      <span className="ui-routines__secondary">{detail}</span>
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button type="button" className="ui-routines__run" onClick={() => onOpen(run)}>{content}</button>
      ) : (
        <div className="ui-routines__run">{content}</div>
      )}
    </li>
  );
}

function RunsList({ workspaceId, routine, onOpenRun }: { workspaceId: string; routine: Routine; onOpenRun?: OpenRun }) {
  const api = useDraftApi();
  const { data: runs } = useSuspenseQuery(routineRunsQueryOptions(api, workspaceId, routine.id));
  if (runs.length === 0) {
    return <p className="ui-routines__secondary">No runs yet. The first run starts at the next scheduled time.</p>;
  }
  return (
    <ul className="ui-routines__runs">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} timezone={routine.timezone} onOpen={onOpenRun && ((opened) => onOpenRun(opened.id, routine))} />
      ))}
    </ul>
  );
}

/** The newest runs of an agent routine. Each opens in the session view. */
export function RoutineRuns(props: { workspaceId: string; routine: Routine; onOpenRun?: OpenRun }) {
  return (
    <DataBoundary
      fallback={<RunsSkeleton />}
      errorFallback={(retry) => (
        <p className="ui-routines__error" role="alert">
          Runs couldn’t load. <button type="button" className="ui-routines__text-button" onClick={retry}>Try again</button>
        </p>
      )}
    >
      <RunsList {...props} />
    </DataBoundary>
  );
}
