// Minimal in-process mock of the hosted control-plane API + Supabase auth
// endpoints the CLI talks to. Started on an ephemeral port per test.

export interface MockBackendState {
  linkCode: string;
  linkPollResponses: (() => Response)[];
  whoamiResponse: () => Response | Promise<Response>;
  contextResponse: (workspaceId: string) => Response | Promise<Response>;
  refreshResponse: () => Response | Promise<Response>;
  logoutResponse: () => Response | Promise<Response>;
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
      return new Response("not found", { status: 404 });
    },
  });

  return {
    state,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
