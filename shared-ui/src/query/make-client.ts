import { QueryClient } from "@tanstack/react-query";

// No "use client" here: server layouts build a per-request client with this.
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
  });
}
