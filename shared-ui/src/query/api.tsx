"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { SynthesisRunSummary } from "../activity/ActivityList";
import type { CreateRoutineInput, Routine, RoutinePatch, RoutineRun, RoutinesResponse } from "../routines/types";

/** Reads both apps share. Web implements it with the HTTP API, desktop with RPC. */
export interface DraftApi {
  /** The newest runs, a page at a time. `before` is a run's cursor (see runCursor); omit it for the first page. */
  getRuns(before?: string): Promise<SynthesisRunSummary[]>;
  getRoutines(): Promise<RoutinesResponse>;
  updateRoutine(id: string, patch: RoutinePatch): Promise<Routine>;
  createRoutine(input: CreateRoutineInput): Promise<Routine>;
  /** Hides an agent routine and stops its runs. Its past runs stay. */
  deleteRoutine(id: string): Promise<void>;
  getRoutineRuns(id: string): Promise<RoutineRun[]>;
  runRoutine?(id: string): Promise<unknown>;
  getRoutineSlackChannels?(): Promise<Array<{ id: string; name: string }>>;
  getRoutineGithubRepos?(): Promise<string[]>;
}

const DraftApiContext = createContext<DraftApi | null>(null);

export function DraftApiProvider({ api, children }: { api: DraftApi; children: ReactNode }) {
  return <DraftApiContext.Provider value={api}>{children}</DraftApiContext.Provider>;
}

export function useDraftApi(): DraftApi {
  const api = useContext(DraftApiContext);
  if (!api) throw new Error("DraftApiProvider is required");
  return api;
}
