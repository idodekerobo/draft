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

export interface GranolaConnectOptions {
  source: CredentialSource;
  // "workspace" connects the workspace's single shared key (no Draft-side
  // permission gate -- Granola itself restricts who can generate one, see
  // backend/src/routes/connections.ts). Defaults to "personal".
  accountKind: "personal" | "workspace";
}

export interface GranolaConnectDeps {
  reader: CredentialReader;
  connect(body: {
    provider: "granola";
    api_token: string;
    account_kind: "personal" | "workspace";
  }): Promise<FetchResult<ConnectIntegrationResult>>;
  exitProcess(code: number): void;
}

const defaultDeps: GranolaConnectDeps = {
  reader: credentialReader,
  connect: connectIntegration,
  exitProcess: (code) => { process.exit(code); },
};

/** Prompts for a Granola API key and connects it, personal or workspace-scoped. */
export async function runGranolaConnect(
  options: GranolaConnectOptions,
  output: IntegrationOutput,
  deps: GranolaConnectDeps = defaultDeps,
): Promise<number> {
  const handoff = output.event({ status: "awaiting_credentials", provider: "granola" });
  if (handoff !== 0) return handoff;

  let credentials: { api_token: string };
  try {
    credentials = await deps.reader.read("granola", options.source);
  } catch (error) {
    const code = output.error(error instanceof CredentialInputError ? error.code : "invalid_credential_input");
    if (error instanceof CredentialInputError && error.code === "interrupted") deps.exitProcess(code);
    return code;
  }
  output.registerSecret(credentials.api_token);

  // Draft registers the webhook itself using this key -- unlike Fireflies
  // there's no separate paste-into-vendor-UI step, so a successful connect
  // is a single round trip.
  const result = await deps.connect({
    provider: "granola",
    api_token: credentials.api_token,
    account_kind: options.accountKind,
  });
  if (!result.ok) return output.error(result.code);

  return output.event({ status: "connected", provider: "granola" });
}
