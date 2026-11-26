import type { SandboxEndpoint } from "../../metaharness/sandbox/providers";

/** The computer answered with a refusal or a failure. `code` is its own stable word. */
export class ComputerError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ComputerError";
  }
}

export interface JobView {
  id: string;
  state: "running" | "finished" | "cancelled" | "timeout" | "lost";
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  outputBytes: number;
  generation: string;
}

export interface JobPage {
  job: JobView;
  nextOffset: number;
  output: string;
}

export interface ComputerClient {
  health(): Promise<{ generation: string }>;
  exec(input: { id: string; command: string; cwd?: string; timeoutSeconds?: number }): Promise<{ attached: boolean; job: JobView }>;
  job(id: string, from: number): Promise<JobPage>;
  cancel(id: string): Promise<JobView>;
  readFile(path: string): Promise<{ content: string; size: number; truncated: boolean }>;
  writeFile(path: string, content: string, key: string): Promise<{ replayed: boolean }>;
  list(path: string): Promise<{ entries: Array<{ name: string; type: string; size: number }>; truncated: boolean }>;
}

export interface ClientOptions {
  /** Read on each request, so a machine that moved is found again. */
  endpoint: () => SandboxEndpoint;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Waits between tries of a request the network or Fly's proxy dropped. */
  retryDelaysMs?: readonly number[];
}

const WAKING = new Set([502, 503, 504]);

/** Talks to one machine's computer server. Every request is safe to repeat, because jobs and writes carry the caller's ids. */
export function createComputerClient(options: ClientOptions): ComputerClient {
  const doFetch = options.fetch ?? fetch;
  const delays = options.retryDelaysMs ?? [300, 1000, 3000];

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
      const { url, headers } = options.endpoint();
      try {
        const response = await doFetch(`${url}${path}`, {
          method,
          headers: { ...headers, authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
        // A stopped machine that Fly is starting answers 502 or 503 for a moment: try again.
        if (WAKING.has(response.status) && attempt < delays.length) {
          last = new ComputerError("The computer is starting", response.status, "starting");
          continue;
        }
        const parsed = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; message?: string } | null;
        if (!response.ok || parsed?.ok === false) throw new ComputerError(parsed?.message ?? parsed?.error ?? `The computer answered ${response.status}`, response.status, parsed?.error ?? "failed");
        return parsed as T;
      } catch (error) {
        if (error instanceof ComputerError && !WAKING.has(error.status)) throw error;
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("The computer did not answer");
  }

  return {
    health: () => request("GET", "/health"),
    exec: (input) => request("POST", "/jobs", input),
    job: (id, from) => request("GET", `/jobs/${encodeURIComponent(id)}?from=${from}`),
    cancel: async (id) => (await request<{ job: JobView }>("POST", `/jobs/${encodeURIComponent(id)}/cancel`)).job,
    readFile: (path) => request("GET", `/files?path=${encodeURIComponent(path)}`),
    writeFile: (path, content, key) => request("PUT", "/files", { path, content, key }),
    list: (path) => request("GET", `/list?path=${encodeURIComponent(path)}`),
  };
}
