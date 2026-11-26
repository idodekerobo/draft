"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { DataBoundary } from "../query/DataBoundary";
import { useDraftApi } from "../query/api";
import { queryKeys } from "../query/keys";
import { runHistoryQueryOptions } from "../query/options";
import { useRoutineMutations } from "../routines/useRoutineMutations";
import { toast } from "../toast";
import { ActivityList, type UpcomingRoutine } from "./ActivityList";
import { RunDetailView } from "./RunDetailView";

interface ActivityProps {
  workspaceId: string;
  onFixInConnections: () => void;
  onOpenRun?: (sessionId: string) => void;
  onOpenRoutine?: (routineId: string) => void;
}

function relativeTime(iso: string) {
  const minutes = (new Date(iso).getTime() - Date.now()) / 60_000;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(Math.round(minutes), "minute");
  if (Math.abs(minutes) < 1440) return format.format(Math.round(minutes / 60), "hour");
  return format.format(Math.round(minutes / 1440), "day");
}

function UpcomingRow({ routine, pending, disabled, removing, onCancel, buttonRef }: {
  routine: UpcomingRoutine;
  pending: boolean;
  disabled: boolean;
  removing: boolean;
  onCancel: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const absoluteTime = new Date(routine.runAt).toLocaleString(undefined, { timeZone: routine.timezone, dateStyle: "medium", timeStyle: "short" });
  return (
    <li id={`upcoming-${routine.id}`} className={`ui-activity-row ui-activity-upcoming${removing ? " ui-activity-row--removing" : ""}`}>
      <div className="ui-activity-row__text">
        <span className="ui-activity-row__meta">Once · <time dateTime={routine.runAt} title={`${absoluteTime} (${routine.timezone})`}>{relativeTime(routine.runAt)}</time> · set by {routine.setBy.type === "person" ? routine.setBy.name : routine.setBy.title}</span>
        <span className="ui-activity-row__primary">{routine.title}</span>
      </div>
      <button ref={buttonRef} type="button" className="ui-link ui-activity-row__action" disabled={disabled || removing} aria-busy={pending} aria-label={`Cancel ${routine.title}`} onClick={onCancel}>{pending ? "Cancelling…" : "Cancel"}</button>
    </li>
  );
}

function ActivityRuns({ workspaceId, onFixInConnections, onOpenRun, onOpenRoutine }: ActivityProps) {
  const api = useDraftApi();
  const client = useQueryClient();
  const options = runHistoryQueryOptions(api, workspaceId);
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError, refetch } = useSuspenseInfiniteQuery(options);
  const mutations = useRoutineMutations(workspaceId, () => {});
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [focusAfterCancel, setFocusAfterCancel] = useState<string | null>(null);
  // The run whose steps are open, and the run whose button takes focus when they close.
  const [stepsOf, setStepsOf] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const cancelButtons = useRef(new Map<string, HTMLButtonElement>());
  const upcomingHeading = useRef<HTMLHeadingElement>(null);
  const runsHeading = useRef<HTMLHeadingElement>(null);
  const upcoming = data.pages[0]?.upcoming ?? [];
  const upcomingError = data.pages[0]?.upcomingError;
  // Polling may shift a run between pages; show it once.
  const runs = [...new Map(data.pages.flatMap((page) => page.runs).map((run) => [run.id, run])).values()];

  useEffect(() => {
    if (focusAfterCancel === null) return;
    (cancelButtons.current.get(focusAfterCancel) ?? upcomingHeading.current ?? runsHeading.current)?.focus();
    setFocusAfterCancel(null);
  }, [focusAfterCancel]);

  async function cancel(routine: UpcomingRoutine) {
    setCancelling(routine.id);
    try {
      await mutations.remove.mutateAsync(routine.id);
      const nextId = upcoming[upcoming.findIndex((row) => row.id === routine.id) + 1]?.id ?? "";
      setRemoving(routine.id);
      await new Promise((resolve) => setTimeout(resolve, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200));
      client.setQueryData(options.queryKey, (current: typeof data | undefined) => current && ({ ...current, pages: current.pages.map((page) => ({ ...page, upcoming: page.upcoming?.filter((row) => row.id !== routine.id) })) }));
      setFocusAfterCancel(nextId);
      toast.success("Cancelled");
      void client.invalidateQueries({ queryKey: queryKeys.runs(workspaceId) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel this routine. Try again.");
    } finally {
      setCancelling(null);
      setRemoving(null);
    }
  }

  async function runAgain(id: string) {
    setRunning(id);
    try {
      const outcome = await mutations.run.mutateAsync(id);
      if (outcome.status === "started") toast.success("Started");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The run could not start. Try again.");
    } finally {
      setRunning(null);
    }
  }

  async function openCreatedOnce(id: string) {
    const cancelButton = cancelButtons.current.get(id);
    if (cancelButton) {
      cancelButton.scrollIntoView?.({ block: "nearest" });
      cancelButton.focus();
      return;
    }
    try {
      const childRuns = await api.getRoutineRuns(id);
      if (childRuns[0] && onOpenRun) onOpenRun(childRuns[0].id);
      else toast.info("This one-time routine has no runs yet.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load this routine’s runs.");
    }
  }

  if (stepsOf) {
    return <RunDetailView workspaceId={workspaceId} runId={stepsOf} onBack={() => { setReturnTo(stepsOf); setStepsOf(null); }} />;
  }

  return (
    <>
      {(upcoming.length > 0 || upcomingError) && (
        <section className="ui-activity-section" aria-labelledby="activity-upcoming-title">
          <h2 id="activity-upcoming-title" ref={upcomingHeading} tabIndex={-1} className="ui-activity-section-title">Upcoming</h2>
          {upcomingError && <p className="ui-error" role="alert">Couldn't load upcoming routines. <button className="ui-link" type="button" onClick={() => void refetch()}>Try again</button></p>}
          <ul className="ui-rows">
            {upcoming.map((routine) => <UpcomingRow key={routine.id} routine={routine} pending={cancelling === routine.id} disabled={cancelling !== null} removing={removing === routine.id} buttonRef={(element) => { if (element) cancelButtons.current.set(routine.id, element); else cancelButtons.current.delete(routine.id); }} onCancel={() => { if (!cancelling) void cancel(routine); }} />)}
          </ul>
        </section>
      )}
      <section className="ui-activity-section" aria-labelledby="activity-runs-title">
        <h2 id="activity-runs-title" ref={runsHeading} tabIndex={-1} className="ui-activity-section-title">Runs</h2>
        <ActivityList runs={runs} onFixInConnections={onFixInConnections} onOpenRun={onOpenRun} onOpenSteps={(id) => { setReturnTo(null); setStepsOf(id); }} focusStepsFor={returnTo} onOpenRoutine={onOpenRoutine} onOpenCreatedOnce={(id) => void openCreatedOnce(id)} onRunAgain={(id) => { if (!running) void runAgain(id); }} runningRoutineId={running} />
        {hasNextPage && (
          <div className="ui-activity-more">
            <button type="button" className="ui-btn" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>{isFetchingNextPage ? "Loading…" : "Show older runs"}</button>
            {isFetchNextPageError && <p className="ui-error" role="alert">Could not load older runs. Try again.</p>}
          </div>
        )}
      </section>
    </>
  );
}

export function ActivityPanel(props: ActivityProps) {
  return (
    <>
      <h1 className="ui-page__title">Activity</h1>
      <p className="ui-page__intro">What your workspace agents have been doing.</p>
      <DataBoundary fallback={<section className="ui-activity-section"><h2 className="ui-activity-section-title">Upcoming</h2><p className="ui-muted" role="status">Loading activity…</p></section>} errorMessage="Could not load activity.">
        <ActivityRuns {...props} />
      </DataBoundary>
    </>
  );
}
