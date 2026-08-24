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
  // A credential read already in flight on the TTY can't actually be
  // cancelled (it only settles once more input arrives), so once the
  // interrupted message has been emitted, this forces the process to exit
  // rather than risk it hanging until further input arrives.
  exitProcess(code: number): void;
}

const defaultDeps: ClaudeCodeConnectDeps = {
  reader: credentialReader,
  connect: connectIntegration,
  exitProcess: (code) => { process.exit(code); },
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
    const code = output.error(error instanceof CredentialInputError ? error.code : "invalid_credential_input");
    if (error instanceof CredentialInputError && error.code === "interrupted") deps.exitProcess(code);
    return code;
  }
  output.registerSecret(credentials.setup_token);

  const result = await deps.connect({ provider: "claude_code", token: credentials.setup_token });
  if (!result.ok) return output.error(result.code);

  return output.event({ status: "credential_stored", provider: "claude-code" });
}
