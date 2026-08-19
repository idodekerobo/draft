import { authenticateGithubWebhookRequest, GithubWebhookAuthError } from "./request-auth";
import {
  ingestGithubPullRequestEvent,
  ingestGithubPushEvent,
  type GithubPullRequestWebhookPayload,
  type GithubPushWebhookPayload,
} from "../../ingestion/github/normalize";
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  type GithubInstallationWebhookPayload,
  type GithubInstallationRepositoriesWebhookPayload,
} from "../../ingestion/github/installation-sync";
import { recordRouteError } from "../../errors/route-error";

// GitHub posts everything to one App-level URL (no :connectionKey param,
// unlike Linear/Fireflies) and disambiguates tenants via installation.id.
export async function POST(request: Request): Promise<Response> {
  let workspaceId: string | null = null;
  let sourceConnectionId: string | null = null;
  try {
    const { eventType, payload, connection } = await authenticateGithubWebhookRequest(request);

    if (eventType === "ping") return new Response(null, { status: 200 });
    if (!connection) {
      // Plausible race: webhook can arrive before the callback route's upsert finishes.
      return new Response(null, { status: 200 });
    }
    workspaceId = connection.workspace_id;
    sourceConnectionId = connection.id;

    switch (eventType) {
      case "pull_request":
        await ingestGithubPullRequestEvent(connection, payload as unknown as GithubPullRequestWebhookPayload);
        break;
      case "push":
        await ingestGithubPushEvent(connection, payload as unknown as GithubPushWebhookPayload);
        break;
      case "installation":
        await handleInstallationEvent(payload as unknown as GithubInstallationWebhookPayload);
        break;
      case "installation_repositories":
        await handleInstallationRepositoriesEvent(
          payload as unknown as GithubInstallationRepositoriesWebhookPayload,
        );
        break;
      default:
        break;
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof GithubWebhookAuthError) {
      console.log(`[github webhook] auth failed: ${error.message}`);
      return new Response(null, { status: 401 });
    }
    recordRouteError({
      workspaceId,
      sourceConnectionId,
      operation: "ingestion",
      errorCode: "github_webhook_failed",
      error,
    });
    return new Response(null, { status: 500 });
  }
}
