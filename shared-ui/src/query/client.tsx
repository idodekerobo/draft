"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { DraftApiProvider, type DraftApi } from "./api";
import { makeQueryClient } from "./make-client";

/** One QueryClient per mounted app. Never share one across server requests. */
export function DraftQueryProvider({ api, children }: { api: DraftApi; children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <DraftApiProvider api={api}>{children}</DraftApiProvider>
    </QueryClientProvider>
  );
}
