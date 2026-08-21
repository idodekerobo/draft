import {
  connectIntegration,
  type ConnectIntegrationResult,
  type FetchResult,
} from "../../cloud-client.ts";
import {
  CredentialInputError,
  credentialReader,
  type CredentialReader,
  type CredentialSource,
} from "../credentials.ts";
import type { IntegrationOutput } from "../safe-output.ts";

export interface LinearConnectOptions {
  source: CredentialSource;
}

export interface LinearConnectDeps {
  reader: CredentialReader;
  connect(body: { provider: "linear"; api_token: string }): Promise<FetchResult<ConnectIntegrationResult>>;
}

const defaultDeps: LinearConnectDeps = {
  reader: credentialReader,
  connect: connectIntegration,
};

export async function runLinearConnect(
  options: LinearConnectOptions,
  output: IntegrationOutput,
  deps: LinearConnectDeps = defaultDeps,
): Promise<number> {
  const handoff = output.event({ status: "awaiting_credentials", provider: "linear" });
  if (handoff !== 0) return handoff;

  let credentials: { api_key: string };
  try {
    credentials = await deps.reader.read("linear", options.source);
  } catch (error) {
    return output.error(error instanceof CredentialInputError ? error.code : "invalid_credential_input");
  }
  output.registerSecret(credentials.api_key);

  const result = await deps.connect({ provider: "linear", api_token: credentials.api_key });
  if (!result.ok) return output.error(result.code);

  const cleanupPending = "cleanup_pending" in result.value && result.value.cleanup_pending === true;
  return output.event({
    status: "connected",
    provider: "linear",
    ...(cleanupPending ? { cleanup_pending: true as const } : {}),
  });
}
