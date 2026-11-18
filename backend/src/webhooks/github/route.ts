import { githubPullRequestFacts, githubPushFacts } from "../../routines/event-facts";
import { fireEnqueueRoutineEvents } from "../../events/enqueue-routine-events";
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
  let connectionId: string | null = null;
  try {
    const { eventType, payload, connection } = await authenticateGithubWebhookRequest(request);

    if (eventType === "ping") return new Response(null, { status: 200 });
    if (!connection) {
      // Plausible race: webhook can arrive before the callback route's upsert finishes.
      return new Response(null, { status: 200 });
    }
    workspaceId = connection.workspace_id;
    connectionId = connection.id;

    switch (eventType) {
      case "pull_request": {
        const pr = payload as unknown as GithubPullRequestWebhookPayload;
        const ingested = await ingestGithubPullRequestEvent(connection, pr);
        const name = pr.action === "opened" ? "github.pull_request_opened" : pr.action === "closed" && pr.pull_request.merged ? "github.pull_request_merged" : null;
        if (name && "sourceItemId" in ingested) {
          fireEnqueueRoutineEvents({ workspaceId: connection.workspace_id, connectionId: connection.id, name, eventId: `${pr.repository.full_name}#${pr.pull_request.number}`, sourceItemId: ingested.sourceItemId, facts: githubPullRequestFacts(pr), concurrencyKey: `github:${pr.repository.full_name}#${pr.pull_request.number}` });
        }
        break;
      }
      case "push": {
        const push = payload as unknown as GithubPushWebhookPayload;
        const ingested = await ingestGithubPushEvent(connection, push);
        // One run per push, read from its newest commit.
        const head = "sourceItemIds" in ingested ? ingested.sourceItemIds.at(-1) : undefined;
        if (head) fireEnqueueRoutineEvents({ workspaceId: connection.workspace_id, connectionId: connection.id, name: "github.push", eventId: `${push.repository.full_name}@${push.commits.at(-1)!.id}`, sourceItemId: head, facts: githubPushFacts(push), concurrencyKey: `github:${push.repository.full_name}@${push.ref.replace(/^refs\/heads\//, "")}` });
        break;
      }
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
      connectionId,
      operation: "ingestion",
      errorCode: "github_webhook_failed",
      error,
    });
    return new Response(null, { status: 500 });
  }
}
