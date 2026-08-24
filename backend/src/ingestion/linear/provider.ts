const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_WEBHOOK_RESOURCE_TYPES = ["Issue", "Comment", "Project", "Cycle", "ProjectUpdate"];

export type LinearProviderErrorCode =
  | "linear_webhook_create_failed"
  | "linear_webhook_delete_failed";

export class LinearProviderError extends Error {
  constructor(public readonly code: LinearProviderErrorCode) {
    super(code);
    this.name = "LinearProviderError";
  }
}

const CREATE_WEBHOOK_MUTATION = `
  mutation CreateWebhook($url: String!, $resourceTypes: [String!]!, $secret: String!) {
    webhookCreate(input: { url: $url, resourceTypes: $resourceTypes, allPublicTeams: true, secret: $secret }) {
      success
      webhook {
        id
        enabled
      }
    }
  }
`;

const DELETE_WEBHOOK_MUTATION = `
  mutation DeleteWebhook($id: String!) {
    webhookDelete(id: $id) {
      success
    }
  }
`;

interface GraphQLPayload {
  data?: unknown;
  errors?: unknown;
}

async function requestLinearGraphQL(
  apiToken: string,
  query: string,
  variables: Record<string, unknown>,
  errorCode: LinearProviderErrorCode,
  fetchFn: typeof fetch,
): Promise<GraphQLPayload> {
  try {
    const response = await fetchFn(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Personal API keys are not prefixed with "Bearer ".
        Authorization: apiToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new LinearProviderError(errorCode);

    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new LinearProviderError(errorCode);
    }
    const graphQLPayload = payload as GraphQLPayload;
    if (graphQLPayload.errors !== undefined) {
      if (!Array.isArray(graphQLPayload.errors) || graphQLPayload.errors.length > 0) {
        throw new LinearProviderError(errorCode);
      }
    }
    if (!graphQLPayload.data || typeof graphQLPayload.data !== "object") {
      throw new LinearProviderError(errorCode);
    }
    return graphQLPayload;
  } catch (error) {
    if (error instanceof LinearProviderError) throw error;
    throw new LinearProviderError(errorCode);
  }
}

export async function createLinearWebhook(
  apiToken: string,
  url: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string }> {
  const payload = await requestLinearGraphQL(
    apiToken,
    CREATE_WEBHOOK_MUTATION,
    { url, resourceTypes: LINEAR_WEBHOOK_RESOURCE_TYPES, secret },
    "linear_webhook_create_failed",
    fetchFn,
  );
  const result = (payload.data as { webhookCreate?: unknown }).webhookCreate;
  if (!result || typeof result !== "object") {
    throw new LinearProviderError("linear_webhook_create_failed");
  }
  const create = result as { success?: unknown; webhook?: unknown };
  if (create.success !== true || !create.webhook || typeof create.webhook !== "object") {
    throw new LinearProviderError("linear_webhook_create_failed");
  }
  const id = (create.webhook as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new LinearProviderError("linear_webhook_create_failed");
  }
  return { id };
}

export async function deleteLinearWebhook(
  apiToken: string,
  id: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const payload = await requestLinearGraphQL(
    apiToken,
    DELETE_WEBHOOK_MUTATION,
    { id },
    "linear_webhook_delete_failed",
    fetchFn,
  );
  const result = (payload.data as { webhookDelete?: unknown }).webhookDelete;
  if (!result || typeof result !== "object" || (result as { success?: unknown }).success !== true) {
    throw new LinearProviderError("linear_webhook_delete_failed");
  }
}
