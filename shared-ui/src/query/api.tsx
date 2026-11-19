"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { TrackFn } from "../analytics/events";
import type { SynthesisRunsPage } from "../activity/ActivityList";
import type { CreateRoutineInput, Routine, RoutinePatch, RoutineRun, RoutineRunOutcome, RoutinesResponse } from "../routines/types";

/** Reads both apps share. Web implements it with the HTTP API, desktop with RPC. */
export interface DraftApi {
  /** The newest runs, a page at a time. `before` is a run's cursor (see runCursor); omit it for the first page, which also carries upcoming routines. */
  getRuns(before?: string): Promise<SynthesisRunsPage>;
  getRoutines(): Promise<RoutinesResponse>;
  updateRoutine(id: string, patch: RoutinePatch): Promise<Routine>;
  createRoutine(input: CreateRoutineInput): Promise<Routine>;
  /** Hides an agent routine and stops its runs. Its past runs stay. */
  deleteRoutine(id: string): Promise<void>;
  /** One routine's runs, 50 at a time; `before` is the last shown run's cursor (see routineRunCursor). */
  getRoutineRuns(id: string, before?: string): Promise<RoutineRun[]>;
  runRoutine?(id: string): Promise<RoutineRunOutcome>;
  getRoutineSlackChannels?(): Promise<Array<{ id: string; name: string }>>;
  getRoutineGithubRepos?(): Promise<string[]>;
}

const DraftApiContext = createContext<DraftApi | null>(null);

const DraftTrackContext = createContext<TrackFn>(() => {});
export const useDraftTrack = () => useContext(DraftTrackContext);

export function DraftApiProvider({ api, children, track }: { api: DraftApi; children: ReactNode; track?: TrackFn }) {
  return <DraftTrackContext.Provider value={track ?? (() => {})}><DraftApiContext.Provider value={api}>{children}</DraftApiContext.Provider></DraftTrackContext.Provider>;
}

export function useDraftApi(): DraftApi {
  const api = useContext(DraftApiContext);
  if (!api) throw new Error("DraftApiProvider is required");
  return api;
}
