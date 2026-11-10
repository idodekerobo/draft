const DEFAULT_BASE_URL = "https://api.machines.dev";
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FlyMachineState =
  | "created"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "replacing"
  | "destroying"
  | "destroyed"
  | "failed"
  | string;

export interface FlyMachineGuest {
  cpu_kind?: "shared" | "performance" | string;
  cpus?: number;
  memory_mb?: number;
  gpu_kind?: string;
  gpus?: number;
  host_dedication_id?: string;
  kernel_args?: string[];
}

export interface FlyMachine {
  id: string;
  name?: string;
  state: FlyMachineState;
  region?: string;
  instance_id?: string;
  [key: string]: unknown;
}

export interface FlyMachineFile {
  guest_path: string;
  raw_value: string;
}

export type SandboxFileContents = string | Uint8Array;
export type SandboxFiles = Readonly<Record<string, SandboxFileContents>>;

export interface CreateFlyMachineInput {
  /** Fully qualified, immutable image reference supplied by the caller. */
  image: string;
  files: SandboxFiles;
  env?: Readonly<Record<string, string>>;
  region?: string;
  guest?: FlyMachineGuest;
  metadata?: Readonly<Record<string, string>>;
  name?: string;
}

export interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  files: FlyMachineFile[];
  auto_destroy: true;
  restart: { policy: "no" };
  guest?: FlyMachineGuest;
  metadata?: Record<string, string>;
}

export interface CreateFlyMachineRequest {
  name?: string;
  region?: string;
  config: FlyMachineConfig;
}

export interface WaitForStateOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface FlyMachinesClientOptions {
  app: string;
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class FlyMachinesApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly requestId?: string;

  constructor(input: {
    method: string;
    url: string;
    status: number;
    requestId?: string;
  }) {
    const requestSuffix = input.requestId
      ? ` (request id: ${input.requestId})`
      : "";
    super(
      `Fly Machines API ${input.method} ${input.url} failed with HTTP ${input.status}${requestSuffix}`,
    );
    this.name = "FlyMachinesApiError";
    this.status = input.status;
    this.method = input.method;
    this.url = input.url;
    this.requestId = input.requestId;
  }
}

export class FlyMachineWaitTimeoutError extends Error {
  readonly machineId: string;
  readonly desiredState: FlyMachineState;
  readonly lastState?: FlyMachineState;
  readonly timeoutMs: number;

  constructor(input: {
    machineId: string;
    desiredState: FlyMachineState;
    lastState?: FlyMachineState;
    timeoutMs: number;
  }) {
    const lastState = input.lastState ? `; last state was ${input.lastState}` : "";
    super(
      `Timed out after ${input.timeoutMs}ms waiting for Fly machine ${input.machineId} to reach ${input.desiredState}${lastState}`,
    );
    this.name = "FlyMachineWaitTimeoutError";
    this.machineId = input.machineId;
    this.desiredState = input.desiredState;
    this.lastState = input.lastState;
    this.timeoutMs = input.timeoutMs;
  }
}

/**
 * Reject paths that could escape the sandbox root or be interpreted differently
 * across host and guest operating systems.
 */
export function assertRelativeGuestPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`Sandbox file path must be a safe relative guest path: ${path}`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function assertBoundedNumber(value: number, label: string, allowZero: boolean): void {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
}

function base64(contents: SandboxFileContents): string {
  return Buffer.from(contents).toString("base64");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function buildCreateFlyMachineRequest(
  input: CreateFlyMachineInput,
): CreateFlyMachineRequest {
  assertNonEmpty(input.image, "image");
  const files = Object.entries(input.files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, contents]) => {
      assertRelativeGuestPath(path);
      if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
        throw new Error(`Sandbox file contents must be a string or Uint8Array: ${path}`);
      }
      return { guest_path: `/run/${path}`, raw_value: base64(contents) };
    });

  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.region === undefined ? {} : { region: input.region }),
    config: {
      image: input.image,
      env: { ...(input.env ?? {}) },
      files,
      auto_destroy: true,
      restart: { policy: "no" },
      ...(input.guest === undefined ? {} : { guest: { ...input.guest } }),
      ...(input.metadata === undefined
        ? {}
        : { metadata: { ...input.metadata } }),
    },
  };
}

export class FlyMachinesClient {
  private readonly app: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: FlyMachinesClientOptions) {
    assertNonEmpty(options.app, "app");
    assertNonEmpty(options.token, "token");
    this.app = options.app;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async create(input: CreateFlyMachineInput): Promise<FlyMachine> {
    const url = `${this.appMachinesUrl()}/machines`;
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCreateFlyMachineRequest(input)),
    });
    return this.readMachine(response, "POST", url);
  }

  async get(machineId: string, signal?: AbortSignal): Promise<FlyMachine> {
    assertNonEmpty(machineId, "machineId");
    const url = `${this.appMachinesUrl()}/machines/${encodeURIComponent(machineId)}`;
    const response = await this.request(url, { method: "GET", signal });
    return this.readMachine(response, "GET", url);
  }

  async waitForState(
    machineId: string,
    desiredState: FlyMachineState,
    options: WaitForStateOptions = {},
  ): Promise<FlyMachine> {
    assertNonEmpty(desiredState, "desiredState");
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    assertBoundedNumber(timeoutMs, "timeoutMs", false);
    assertBoundedNumber(pollIntervalMs, "pollIntervalMs", false);

    const startedAt = this.now();
    const deadline = startedAt + timeoutMs;
    let lastState: FlyMachineState | undefined;

    while (this.now() < deadline) {
      const controller = new AbortController();
      const remainingMs = Math.max(1, deadline - this.now());
      const timer = setTimeout(() => controller.abort(), remainingMs);
      try {
        const machine = await this.get(machineId, controller.signal);
        lastState = machine.state;
        if (machine.state === desiredState) return machine;
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const remainingAfterRequestMs = deadline - this.now();
      if (remainingAfterRequestMs <= 0) break;
      await this.sleep(Math.min(pollIntervalMs, remainingAfterRequestMs));
    }

    throw new FlyMachineWaitTimeoutError({
      machineId,
      desiredState,
      lastState,
      timeoutMs,
    });
  }

  async forceDelete(machineId: string): Promise<void> {
    assertNonEmpty(machineId, "machineId");
    const url = `${this.appMachinesUrl()}/machines/${encodeURIComponent(machineId)}?force=true`;
    await this.request(url, { method: "DELETE" });
  }

  private appMachinesUrl(): string {
    return `${this.baseUrl}/v1/apps/${encodeURIComponent(this.app)}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/json");

    const response = await this.fetchImpl(url, { ...init, headers });
    if (!response.ok) {
      throw new FlyMachinesApiError({
        method: init.method ?? "GET",
        url,
        status: response.status,
        requestId:
          response.headers.get("fly-request-id") ??
          response.headers.get("x-request-id") ??
          undefined,
      });
    }
    return response;
  }

  private async readMachine(
    response: Response,
    method: string,
    url: string,
  ): Promise<FlyMachine> {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(`Fly Machines API ${method} ${url} returned invalid JSON`);
    }
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as Record<string, unknown>).id !== "string" ||
      typeof (value as Record<string, unknown>).state !== "string"
    ) {
      throw new Error(`Fly Machines API ${method} ${url} returned an invalid machine`);
    }
    return value as FlyMachine;
  }
}
