import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let rpcResult: { data: unknown; error: { message: string } | null } = { data: { last_seq: 2, inserted: 2 }, error: null };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let storageObjects: Array<{ name: string }> = [];
const signedPaths: string[] = [];
const removedObjects: string[] = [];
const queriedTables: string[] = [];

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let inserted: Row[] = [];
let updates: Array<{ table: string; payload: Row }> = [];
let errorRows: Row[] = [];

function queryBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const gts: [string, number][] = [];
  const ins: [string, unknown[]][] = [];
  const ltes: [string, number][] = [];
  const nots: [string, unknown][] = [];
  const iss: [string, unknown][] = [];
  let insertPayload: Row | undefined;
  let updatePayload: Row | undefined;

  const matches = () =>
    (tables[table] ?? []).filter(
      (row) =>
        eqs.every(([col, v]) => row[col] === v) &&
        iss.every(([col, v]) => (row[col] ?? null) === v) &&
        ins.every(([col, vs]) => vs.includes(row[col])) &&
        gts.every(([col, v]) => (row[col] as number) > v) &&
        ltes.every(([col, v]) => (row[col] as number) <= v) &&
        nots.every(([col, v]) => (row[col] ?? null) !== v),
    );

  const builder = {
    select: () => builder,
    insert: (payload: Row) => {
      if (table === "errors") {
        errorRows.push(payload);
        return Promise.resolve({ data: null, error: null });
      }
      insertPayload = payload;
      return builder;
    },
    update: (payload: Row) => {
      updatePayload = payload;
      updates.push({ table, payload });
      return builder;
    },
    eq: (col: string, value: unknown) => (eqs.push([col, value]), builder),
    in: (col: string, values: unknown[]) => (ins.push([col, values]), builder),
    neq: () => builder,
    is: (col: string, value: unknown) => (iss.push([col, value]), builder),
    gt: (col: string, value: number) => (gts.push([col, value]), builder),
    lte: (col: string, value: number) => (ltes.push([col, value]), builder),
    not: (col: string, _operator: string, value: unknown) => (nots.push([col, value]), builder),
    order: () => builder,
    limit: () => builder,
    async maybeSingle() {
      return { data: matches()[0] ?? null, error: null };
    },
    async single() {
      const row = { id: "new-session", status: "starting", last_seq: 0, ...insertPayload };
      inserted.push(row);
      return { data: row, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      if (updatePayload) return resolve({ data: null, error: null });
      return resolve({ data: matches(), error: null });
    },
  };
  return builder;
}

mock.module("../../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => accessResult }));
mock.module("../../../db/client", () => ({
  serviceClient: {
    from: (table: string) => (queriedTables.push(table), queryBuilder(table)),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path: string) => {
          signedPaths.push(path);
          return { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null };
        },
        list: async () => ({ data: storageObjects, error: null }),
        remove: async (keys: string[]) => {
          removedObjects.push(...keys);
          return { data: keys, error: null };
        },
      }),
    },
  },
}));

const routes = await import("../../../routes/sessions-live");

const WS = "ws-1";
const SESSION = "session-1";

function session(overrides: Row = {}): Row {
  return {
    id: SESSION,
    workspace_id: WS,
    owner_user_id: "user-1",
    status: "live",
    title: null,
    native_session_id: null,
    host_id: "host-1",
    last_seq: 0,
    ...overrides,
  };
}

function post(path: string, body: unknown, params: Record<string, string> = { id: WS, sessionId: SESSION }) {
  const req = new Request(`http://localhost${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  return Object.assign(req, { params }) as never;
}

const userLine = (uuid: string, text: string) => ({
  stream: "root.jsonl",
  position: 0,
  raw: JSON.stringify({ type: "user", uuid, message: { role: "user", content: text } }),
});

beforeEach(() => {
  accessResult = null;
  rpcResult = { data: { last_seq: 2, inserted: 2 }, error: null };
  rpcCalls.length = 0;
  storageObjects = [];
  signedPaths.length = 0;
  removedObjects.length = 0;
  queriedTables.length = 0;
  inserted = [];
  updates = [];
  errorRows = [];
  tables = {
    sessions: [session()],
    session_events: [],
    users: [{ id: "user-1", display_name: "Maya", email: "maya@example.test" }],
  };
});



export { tables, rpcResult, updates, session, routes, WS, SESSION };
