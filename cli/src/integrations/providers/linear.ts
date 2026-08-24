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
  // A credential read already in flight on the TTY can't actually be
  // cancelled (it only settles once more input arrives), so once the
  // interrupted message has been emitted, this forces the process to exit
  // rather than risk it hanging until further input arrives.
  exitProcess(code: number): void;
}

const defaultDeps: LinearConnectDeps = {
  reader: credentialReader,
  connect: connectIntegration,
  exitProcess: (code) => { process.exit(code); },
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
    const code = output.error(error instanceof CredentialInputError ? error.code : "invalid_credential_input");
    if (error instanceof CredentialInputError && error.code === "interrupted") deps.exitProcess(code);
    return code;
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
