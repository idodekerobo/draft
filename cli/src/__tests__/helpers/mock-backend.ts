// Minimal in-process mock of the hosted control-plane API + Supabase auth
// endpoints the CLI talks to. Started on an ephemeral port per test.

export interface MockBackendState {
  linkCode: string;
  linkPollResponses: (() => Response)[];
  whoamiResponse: () => Response | Promise<Response>;
  contextResponse: (workspaceId: string) => Response | Promise<Response>;
  refreshResponse: () => Response | Promise<Response>;
  logoutResponse: () => Response | Promise<Response>;
  sessionTokensResponse: (workspaceId: string) => Response | Promise<Response>;
  sessionsListResponse: (workspaceId: string, url: URL) => Response | Promise<Response>;
  sessionReadResponse: (workspaceId: string, sessionId: string, url: URL) => Response | Promise<Response>;
  sessionsIngestRequests: { url: string; headers: Record<string, string>; body: string }[];
  sessionsIngestResponse: () => Response | Promise<Response>;
}

export function defaultWhoami(overrides: Partial<{ organization_id: string | null; primary_team_id: string | null; workspace_id: string | null; onboarding_completed_at: string | null }> = {}) {
  return Response.json({ organization_id: null, primary_team_id: null, workspace_id: "ws-1", onboarding_completed_at: null, ...overrides });
}

export function createMockBackend() {
  const state: MockBackendState = {
    linkCode: "code123",
    linkPollResponses: [],
    whoamiResponse: () => defaultWhoami(),
    contextResponse: () => Response.json({ versionId: "v1", versionNumber: 1, contentHash: "hash1", creationReason: "synthesis", createdAt: "2026-01-01T00:00:00.000Z", documents: {} }),
    refreshResponse: () => Response.json({ access_token: "refreshed-at", refresh_token: "refreshed-rt", expires_in: 3600 }),
    logoutResponse: () => new Response(null, { status: 204 }),
    sessionTokensResponse: () => Response.json({ id: "cred-1", token: "draft_sit_cred-1_secret" }),
    sessionsListResponse: () => Response.json({ sessions: [] }),
    sessionReadResponse: () => Response.json({ summary: null }),
    sessionsIngestRequests: [],
    sessionsIngestResponse: () => Response.json({ ok: true, sessionId: "session-1" }),
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/link") return Response.json({ code: state.linkCode });
      if (req.method === "GET" && url.pathname === `/link/${state.linkCode}`) {
        const next = state.linkPollResponses.shift();
        return next ? next() : new Response(null, { status: 204 });
      }
      if (req.method === "GET" && url.pathname === "/whoami") return state.whoamiResponse();
      if (req.method === "GET" && /^\/workspaces\/[^/]+\/context$/.test(url.pathname)) {
        const workspaceId = url.pathname.split("/")[2];
        return state.contextResponse(workspaceId);
      }
      if (req.method === "POST" && url.pathname === "/auth/v1/token") return state.refreshResponse();
      if (req.method === "POST" && url.pathname === "/auth/v1/logout") return state.logoutResponse();
      if (req.method === "POST" && /^\/workspaces\/[^/]+\/sessions\/tokens$/.test(url.pathname)) {
        return state.sessionTokensResponse(url.pathname.split("/")[2]!);
      }
      if (req.method === "GET" && /^\/workspaces\/[^/]+\/sessions$/.test(url.pathname)) {
        return state.sessionsListResponse(url.pathname.split("/")[2]!, url);
      }
      if (req.method === "GET" && /^\/workspaces\/[^/]+\/sessions\/[^/]+$/.test(url.pathname)) {
        const parts = url.pathname.split("/");
        return state.sessionReadResponse(parts[2]!, parts[4]!, url);
      }
      if (req.method === "POST" && url.pathname === "/sessions/ingest") {
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => { headers[key] = value; });
        state.sessionsIngestRequests.push({ url: req.url, headers, body: await req.text() });
        return state.sessionsIngestResponse();
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    state,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
