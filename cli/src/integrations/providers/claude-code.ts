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

export interface ClaudeCodeConnectOptions {
  source: CredentialSource;
}

export interface ClaudeCodeConnectDeps {
  reader: CredentialReader;
  connect(body: { provider: "claude_code"; token: string }): Promise<FetchResult<ConnectIntegrationResult>>;
}

const defaultDeps: ClaudeCodeConnectDeps = {
  reader: credentialReader,
  connect: connectIntegration,
};

export async function runClaudeCodeConnect(
  options: ClaudeCodeConnectOptions,
  output: IntegrationOutput,
  deps: ClaudeCodeConnectDeps = defaultDeps,
): Promise<number> {
  const handoff = output.event({ status: "awaiting_credentials", provider: "claude-code" });
  if (handoff !== 0) return handoff;

  let credentials: { setup_token: string };
  try {
    credentials = await deps.reader.read("claude-code", options.source);
  } catch (error) {
    return output.error(error instanceof CredentialInputError ? error.code : "invalid_credential_input");
  }
  output.registerSecret(credentials.setup_token);

  const result = await deps.connect({ provider: "claude_code", token: credentials.setup_token });
  if (!result.ok) return output.error(result.code);

  return output.event({ status: "credential_stored", provider: "claude-code" });
}
