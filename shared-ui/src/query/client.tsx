"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { TrackFn } from "../analytics/events";
import { DraftApiProvider, type DraftApi } from "./api";
import { makeQueryClient } from "./make-client";

/** One QueryClient per mounted app. Never share one across server requests. */
export function DraftQueryProvider({ api, children, track }: { api: DraftApi; children: ReactNode; track?: TrackFn }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <DraftApiProvider api={api} track={track}>{children}</DraftApiProvider>
    </QueryClientProvider>
  );
}
