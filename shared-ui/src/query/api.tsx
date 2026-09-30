"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { SynthesisRunSummary } from "../activity/ActivityList";

/** Reads both apps share. Web implements it with the HTTP API, desktop with RPC. */
export interface DraftApi {
  getRuns(): Promise<SynthesisRunSummary[]>;
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
