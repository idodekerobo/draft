import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { adminRevokeCredential, mintSessionIngestToken } from "../credentials/session-ingest-token";
import { findOrCreateSessionProject } from "../credentials/session-projects";
import { recordRouteError } from "../errors/route-error";
import type { AgentSessionProvider } from "../types/enums";

type SessionTokensRequest = Bun.BunRequest<"/workspaces/:id/sessions/tokens">;
type SessionTokenRevokeRequest = Bun.BunRequest<"/workspaces/:id/sessions/tokens/:credentialId">;

interface MintBody {
  // Repo hint (e.g. cwd basename) shown later in a credentials list —
  // purely descriptive, no server behavior keys off it.
  label?: string;
  // Client-generated uuid, persisted into the repo's committed config so
  // repeated `enable` calls (and every teammate's clone) resolve to the
  // same session_projects row.
  projectKey: string;
  allowedProviders: AgentSessionProvider[];
}

function isMintBody(value: unknown): value is MintBody {
  if (value === null || typeof value !== "object") return false;
  const body = value as Partial<MintBody>;
  return (
    (body.label === undefined || typeof body.label === "string") &&
    typeof body.projectKey === "string" &&
    body.projectKey.length > 0 &&
    Array.isArray(body.allowedProviders) &&
    body.allowedProviders.length > 0 &&
    body.allowedProviders.every((p) => typeof p === "string")
  );
}

export const POST = withAuth<SessionTokensRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isMintBody(body)) return Response.json({ error: "invalid_body" }, { status: 400 });

  try {
    const sessionProjectId = await findOrCreateSessionProject(serviceClient, req.params.id, body.projectKey, body.label ?? null);
    const minted = await mintSessionIngestToken(serviceClient, {
      workspaceId: req.params.id,
      label: body.label ?? null,
      sessionProjectId,
      allowedProviders: body.allowedProviders,
    });
    return Response.json({
      id: minted.id,
      token: minted.token,
      sessionProjectId,
      credentialScope: "ingest-only, shared with repo access",
    });
  } catch (err) {
    recordRouteError({
      workspaceId: req.params.id,
      operation: "auth",
      errorCode: "session_token_mint_failed",
      error: err,
    });
    return Response.json({ error: "mint_failed" }, { status: 500 });
  }
});

// Administrative hard revoke by credential id — for a credential recovered
// from git history. Requires only workspace membership, not the
// credential's secret itself.
export const DELETE = withAuth<SessionTokenRevokeRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const ok = await adminRevokeCredential(serviceClient, req.params.id, req.params.credentialId);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
});
