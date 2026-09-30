"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useDraftApi } from "./api";
import { runsQueryOptions } from "./options";

export function useRuns(workspaceId: string) {
  return useSuspenseQuery(runsQueryOptions(useDraftApi(), workspaceId));
}
