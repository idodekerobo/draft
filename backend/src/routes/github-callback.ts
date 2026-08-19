import { getInstallSession, resolveInstallSession } from "../auth/github-install-store";
import { githubClient } from "../ingestion/github/client-instance";
import { GithubClientError } from "../ingestion/github/client";
import { upsertSourceConnection } from "../ingestion/upsert-source-item";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";

const RETURN_TO_DRAFT_HTML = (message: string) =>
  `<!doctype html><html><body><p>${message}</p><p>You can close this tab and return to Draft.</p></body></html>`;

const OWNER_APPROVAL_MESSAGE =
  "This GitHub organization requires owner approval — ask your org owner to install the app, then click Connect GitHub again.";

// The App's one configured Callback URL -- unauthenticated (a plain browser
// redirect from GitHub, no bearer token available). Spoofable per GitHub's
// own docs (anyone can hit this with an arbitrary installation_id), so
// verifyInstallation runs before any source_connections write.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");
  const code = url.searchParams.get("state");

  if (!code) {
    return new Response(RETURN_TO_DRAFT_HTML("Missing state parameter."), {
      status: 400,
      headers: { "content-type": "text/html" },
    });
  }

  const session = getInstallSession(code);
  if (session.status !== "pending") {
    return new Response(RETURN_TO_DRAFT_HTML("This install link has expired or was already used."), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }

  if (setupAction !== "install") {
    // No durable installation_id to bind for a pending owner-approval request
    // (setup_action: "request") -- v1 does not support auto-completing this
    // path. See plans/draftv2/0047's Decision 3 (P0-1).
    resolveInstallSession(code, { status: "error", errorMessage: OWNER_APPROVAL_MESSAGE });
    return new Response(RETURN_TO_DRAFT_HTML(OWNER_APPROVAL_MESSAGE), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }

  if (!installationId) {
    resolveInstallSession(code, { status: "error", errorMessage: "GitHub did not send an installation id." });
    return new Response(RETURN_TO_DRAFT_HTML("Missing installation id."), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }

  try {
    const installation = await githubClient.verifyInstallation(installationId);

    await upsertSourceConnection(serviceClient, {
      workspace_id: session.workspaceId,
      provider: "github",
      connection_key: installationId,
      status: "active",
      display_name: installation.accountLogin,
      external_account_id: String(installation.accountId),
      credential_id: null,
    });

    resolveInstallSession(code, { status: "connected" });
    return new Response(RETURN_TO_DRAFT_HTML("GitHub connected."), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  } catch (error) {
    const message =
      error instanceof GithubClientError
        ? "Could not verify this GitHub installation."
        : "Something went wrong connecting GitHub.";
    resolveInstallSession(code, { status: "error", errorMessage: message });
    recordRouteError({
      workspaceId: session.workspaceId,
      operation: "ingestion",
      errorCode: "github_callback_failed",
      error,
    });
    return new Response(RETURN_TO_DRAFT_HTML(message), {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }
}
